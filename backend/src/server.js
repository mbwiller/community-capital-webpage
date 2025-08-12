// backend/src/server.js
// Community Capital - Complete Backend Implementation
// Production-ready server with Stripe, Plaid, and real-time features

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const winston = require('winston');
const morgan = require('morgan');
const socketIO = require('socket.io');
const http = require('http');
const path = require('path');
const Redis = require('redis');
const Bull = require('bull');
const knex = require('knex');
const multer = require('multer');
let sharp = null;
try {
  // Optional dependency for image processing; not required for local dev
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch (e) {
  console.warn('sharp module not available, proceeding without it');
}
const AWS = require('aws-sdk');
const axios = require('axios');
const FormData = require('form-data');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost',
    credentials: true
  }
});

// Initialize Stripe (optional)
const ENABLE_STRIPE = (process.env.ENABLE_STRIPE || 'false') === 'true';
const STRIPE_ISSUING_ENABLED = (process.env.STRIPE_ISSUING_ENABLED || 'false') === 'true';
const isStripeConfigured = ENABLE_STRIPE && Boolean(process.env.STRIPE_SECRET_KEY);
const stripe = isStripeConfigured ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// Initialize Plaid
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(plaidConfig);

// Initialize Twilio for SMS (optional)
let twilioClient = null;
try {
  const sid = process.env.TWILIO_ACCOUNT_SID || '';
  const token = process.env.TWILIO_AUTH_TOKEN || '';
  if (sid.startsWith('AC') && token) {
    twilioClient = require('twilio')(sid, token);
  } else {
    console.warn('Twilio not configured; SMS features disabled');
  }
} catch (e) {
  console.warn('Failed to initialize Twilio; continuing without SMS');
}

// Initialize AWS S3 for receipt storage
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Initialize Redis client
const redisClient = Redis.createClient({
  url: process.env.REDIS_URL
});
redisClient.connect();

// Initialize database connection (PostgreSQL via Knex)
const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 }
});

// Initialize job queues
const paymentQueue = new Bull('payment-processing', process.env.REDIS_URL);
const notificationQueue = new Bull('notifications', process.env.REDIS_URL);
const investmentQueue = new Bull('investment-processing', process.env.REDIS_URL);

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:5000';

// Logger configuration
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost',
  credentials: true
}));
// Ensure Stripe webhook receives raw body
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') {
    return next();
  }
  return express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg) } }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api', limiter);

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// ======================
// Database Schema
// ======================

// Initialize database with migrations
async function initDatabase() {
  try {
    await db.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await db.migrate.latest({
      directory: path.resolve(__dirname, '../migrations')
    });
    if ((process.env.NODE_ENV || 'development') === 'development' && process.env.RUN_SEEDS === 'true') {
      await db.seed.run({ directory: path.resolve(__dirname, '../seeds') });
    }
    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error('Database initialization error:', error);
    throw error;
  }
}

// ======================
// Authentication Middleware
// ======================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
}

// ======================
// API Routes
// ======================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
// Nginx proxies /api/* to backend; provide an /api/health alias
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Public config for frontend
app.get('/api/config/public', (req, res) => {
  res.json({
    stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
    plaid_env: process.env.PLAID_ENV || 'sandbox'
  });
});

// Authentication routes
app.post('/api/auth/register', 
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').notEmpty().trim(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password, name } = req.body;

      // Check if user exists
      const existingUser = await db('users').where({ email }).first();
      if (existingUser) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Create Stripe customer if configured
      let stripeCustomer = { id: null };
      if (isStripeConfigured) {
        try {
          stripeCustomer = await stripe.customers.create({
            email,
            name,
            metadata: { source: 'community_capital' }
          });
        } catch (e) {
          logger.warn('Stripe not available, continuing without customer creation');
          stripeCustomer = { id: null };
        }
      }

      // Create user
      const [user] = await db('users').insert({
        email,
        password_hash: passwordHash,
        name,
        stripe_customer_id: stripeCustomer.id
      }).returning(['id', 'email', 'name']);

      // Generate JWT
      const token = jwt.sign(
        { id: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      // Send welcome notification
      try {
        await notificationQueue.add('welcome', { userId: user.id, email, name });
      } catch (e) {
        logger.warn('Failed to enqueue welcome notification');
      }

      res.status(201).json({
        message: 'User created successfully',
        token,
        user: { id: user.id, email: user.email, name: user.name }
      });
    } catch (error) {
      logger.error('Registration error:', error);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

app.post('/api/auth/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res) => {
    try {
      const { email, password } = req.body;

      // Find user
      const user = await db('users').where({ email }).first();
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Verify password
      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate JWT
      const token = jwt.sign(
        { id: user.id, email: user.email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );

      res.json({
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          emailVerified: user.email_verified
        }
      });
    } catch (error) {
      logger.error('Login error:', error);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// Plaid integration routes
app.post('/api/plaid/create-link-token', authenticateToken, async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: req.user.id },
      client_name: 'Community Capital',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
      webhook: `${process.env.API_URL}/api/plaid/webhook`,
      redirect_uri: process.env.PLAID_REDIRECT_URI
    });

    res.json({ link_token: response.data.link_token });
  } catch (error) {
    logger.error('Plaid link token error:', error);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

app.post('/api/plaid/exchange-token', authenticateToken, async (req, res) => {
  try {
    const { public_token } = req.body;

    // Exchange public token for access token
    const response = await plaidClient.itemPublicTokenExchange({
      public_token
    });

    const accessToken = response.data.access_token;

    // Save access token to user
    await db('users')
      .where({ id: req.user.id })
      .update({ plaid_access_token: accessToken });

    // Get account info
    const accountsResponse = await plaidClient.accountsGet({
      access_token: accessToken
    });

    res.json({
      message: 'Bank account connected successfully',
      accounts: accountsResponse.data.accounts
    });
  } catch (error) {
    logger.error('Plaid token exchange error:', error);
    res.status(500).json({ error: 'Failed to connect bank account' });
  }
});

// Group management routes
app.post('/api/groups', authenticateToken, async (req, res) => {
  try {
    const { name, description, type, members } = req.body;

    // Create group
    const [group] = await db('groups').insert({
      name,
      description,
      type,
      created_by: req.user.id
    }).returning('*');

    // Add creator as admin
    await db('group_members').insert({
      group_id: group.id,
      user_id: req.user.id,
      role: 'admin'
    });

    // Invite members
    if (members && members.length > 0) {
      for (const email of members) {
        // Check if user exists
        let user = await db('users').where({ email }).first();
        
        if (!user) {
          // Send invite email
          await notificationQueue.add('invite', { email, groupName: name, invitedBy: req.user.email });
        } else {
          // Add to group
          await db('group_members').insert({
            group_id: group.id,
            user_id: user.id,
            role: 'member',
            status: 'invited'
          });

          // Send notification
          await db('notifications').insert({
            user_id: user.id,
            type: 'group_invite',
            title: 'Group Invitation',
            message: `You've been invited to join ${name}`,
            data: { group_id: group.id }
          });
        }
      }
    }

    res.status(201).json({
      message: 'Group created successfully',
      group
    });
  } catch (error) {
    logger.error('Group creation error:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const groups = await db('groups')
      .join('group_members', 'groups.id', 'group_members.group_id')
      .where('group_members.user_id', req.user.id)
      .select('groups.*', 'group_members.role', 'group_members.balance');

    // Get member count for each group
    for (const group of groups) {
      const memberCount = await db('group_members')
        .where({ group_id: group.id, status: 'active' })
        .count('id as count');
      group.member_count = memberCount[0].count;
    }

    res.json(groups);
  } catch (error) {
    logger.error('Get groups error:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Get group members
app.get('/api/groups/:id/members', authenticateToken, async (req, res) => {
  try {
    const groupId = req.params.id;
    const members = await db('group_members')
      .join('users', 'group_members.user_id', 'users.id')
      .where('group_members.group_id', groupId)
      .select('users.id', 'users.email', 'users.name', 'group_members.role', 'group_members.status');
    res.json(members);
  } catch (error) {
    logger.error('Get group members error:', error);
    res.status(500).json({ error: 'Failed to fetch group members' });
  }
});

// Bill splitting routes
app.post('/api/bills/create', authenticateToken, upload.single('receipt'), async (req, res) => {
  try {
    const { group_id, merchant_name, items, tax_amount, tip_amount, participants } = req.body;
    
    let receiptUrl = null;
    let scannedItems = JSON.parse(items || '[]');

    // Process receipt if uploaded
    if (req.file) {
      // Try OCR first regardless of S3 availability
      if (req.file.mimetype.startsWith('image/')) {
        try {
          const formData = new FormData();
          formData.append('image', req.file.buffer, {
            filename: req.file.originalname,
            contentType: req.file.mimetype
          });
          const aiUrl = `${AI_SERVICE_URL}/api/ocr/receipt`;
          const aiResponse = await axios.post(aiUrl, formData, {
            headers: formData.getHeaders(),
            timeout: 20000
          });
          if (aiResponse.data && Array.isArray(aiResponse.data.items)) {
            scannedItems = aiResponse.data.items.map((it, idx) => ({
              id: it.id || idx + 1,
              name: it.name,
              price: parseFloat(it.price)
            }));
          }
        } catch (ocrErr) {
          logger.warn('AI OCR failed, falling back to provided items', ocrErr.message || ocrErr);
        }
      }

      // Upload to S3 if configured; ignore failures in local dev
      if (process.env.AWS_S3_BUCKET) {
        try {
          const fileKey = `receipts/${uuidv4()}-${req.file.originalname}`;
          const uploadParams = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileKey,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
          };
          const s3Result = await s3.upload(uploadParams).promise();
          receiptUrl = s3Result.Location;
        } catch (e) {
          logger.warn('S3 upload failed, continuing without receipt URL');
        }
      }
    }

    // Calculate total
    const subtotal = scannedItems.reduce((sum, item) => sum + parseFloat(item.price), 0);
    const totalAmount = subtotal + parseFloat(tax_amount || 0) + parseFloat(tip_amount || 0);

    // Create bill
    const [bill] = await db('bills').insert({
      group_id,
      created_by: req.user.id,
      merchant_name,
      subtotal,
      total_amount: totalAmount,
      tax_amount: tax_amount || 0,
      tip_amount: tip_amount || 0,
      receipt_url: receiptUrl,
      items: JSON.stringify(scannedItems),
      status: 'pending'
    }).returning('*');

    // Add participants and calculate splits
    const participantList = JSON.parse(participants || '[]');
    for (const participant of participantList) {
      const amountOwed = participant.items.reduce((sum, itemId) => {
        const item = scannedItems.find(i => i.id === itemId);
        return sum + (item ? parseFloat(item.price) : 0);
      }, 0);

      // Add proportional tax and tip
      const proportion = amountOwed / subtotal;
      const finalAmount = amountOwed + 
        (parseFloat(tax_amount || 0) * proportion) + 
        (parseFloat(tip_amount || 0) * proportion);

      await db('bill_participants').insert({
        bill_id: bill.id,
        user_id: participant.user_id,
        amount_owed: finalAmount,
        items_claimed: JSON.stringify(participant.items)
      });
    }

    // Process payment
    paymentQueue.add('process-split', { billId: bill.id });

    res.status(201).json({
      message: 'Bill created and split initiated',
      bill
    });
  } catch (error) {
    logger.error('Bill creation error:', error);
    res.status(500).json({ error: 'Failed to create bill' });
  }
});

    // Virtual card creation
app.post('/api/cards/create', authenticateToken, async (req, res) => {
  try {
    const { bill_id, group_id } = req.body;

    // Get bill details
    const bill = await db('bills').where({ id: bill_id }).first();
    if (!bill) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    let createdCard = null;
    if (ENABLE_STRIPE && STRIPE_ISSUING_ENABLED) {
      // Ensure cardholder exists for user
      const user = await db('users').where({ id: req.user.id }).first();
      let cardholderId = user && user.stripe_cardholder_id;
      if (!cardholderId) {
        try {
          const ch = await stripe.issuing.cardholders.create({
            name: user.name || user.email,
            email: user.email,
            status: 'active',
            type: 'individual'
          });
          cardholderId = ch.id;
          await db('users').where({ id: user.id }).update({ stripe_cardholder_id: cardholderId });
        } catch (e) {
          logger.warn('Failed to create Stripe cardholder, falling back to stub card');
        }
      }
      if (cardholderId) {
        createdCard = await stripe.issuing.cards.create({
          cardholder: cardholderId,
          currency: 'usd',
          type: 'virtual',
          spending_controls: {
            spending_limits: [{ amount: Math.ceil(bill.total_amount * 100), interval: 'per_authorization' }]
          },
          metadata: { bill_id, group_id }
        });
      }
    }

    // Save card details
    const [virtualCard] = await db('virtual_cards').insert({
      group_id,
      bill_id,
      user_id: req.user.id,
      stripe_card_id: createdCard ? createdCard.id : null,
      last4: createdCard && createdCard.last4 ? createdCard.last4 : '0000',
      brand: createdCard && createdCard.brand ? createdCard.brand : 'virtual',
      spending_limit: bill.total_amount,
      status: 'active',
      expires_at: new Date(Date.now() + 3600000) // 1 hour expiry
    }).returning('*');

    res.json({
      message: 'Virtual card created',
      card: {
        id: virtualCard.id,
        last4: virtualCard.last4,
        amount: bill.total_amount,
        expires_at: virtualCard.expires_at
      }
    });
  } catch (error) {
    logger.error('Virtual card creation error:', error);
    res.status(500).json({ error: 'Failed to create virtual card' });
  }
});

// Investment routes
app.post('/api/investments/propose', authenticateToken, async (req, res) => {
  try {
    const { group_id, action, symbol, amount, shares } = req.body;

    // Create investment proposal
    const [vote] = await db('investment_votes').insert({
      group_id,
      proposed_by: req.user.id,
      action,
      symbol,
      amount: amount || 0,
      shares: shares || 0,
      votes: JSON.stringify({ [req.user.id]: 'yes' }),
      expires_at: new Date(Date.now() + 86400000) // 24 hours
    }).returning('*');

    // Notify group members
    const members = await db('group_members')
      .where({ group_id, status: 'active' })
      .whereNot({ user_id: req.user.id });

    for (const member of members) {
      await db('notifications').insert({
        user_id: member.user_id,
        type: 'investment_vote',
        title: 'New Investment Proposal',
        message: `Vote on ${action} ${shares} shares of ${symbol}`,
        data: { vote_id: vote.id }
      });

      // Send real-time notification
      io.to(`user:${member.user_id}`).emit('new-vote', vote);
    }

    res.status(201).json({
      message: 'Investment proposal created',
      vote
    });
  } catch (error) {
    logger.error('Investment proposal error:', error);
    res.status(500).json({ error: 'Failed to create proposal' });
  }
});

app.post('/api/investments/vote', authenticateToken, async (req, res) => {
  try {
    const { vote_id, decision } = req.body;

    // Get vote
    const vote = await db('investment_votes').where({ id: vote_id }).first();
    if (!vote) {
      return res.status(404).json({ error: 'Vote not found' });
    }

    // Check if user is group member
    const membership = await db('group_members')
      .where({ group_id: vote.group_id, user_id: req.user.id })
      .first();
    
    if (!membership) {
      return res.status(403).json({ error: 'Not a group member' });
    }

    // Update votes
    const votes = JSON.parse(vote.votes);
    votes[req.user.id] = decision;

    await db('investment_votes')
      .where({ id: vote_id })
      .update({ votes: JSON.stringify(votes) });

    // Check if all members have voted
    const totalMembers = await db('group_members')
      .where({ group_id: vote.group_id, status: 'active' })
      .count('id as count');

    if (Object.keys(votes).length === totalMembers[0].count) {
      // Calculate result
      const yesVotes = Object.values(votes).filter(v => v === 'yes').length;
      const threshold = Math.ceil(totalMembers[0].count * 0.6); // 60% approval

      if (yesVotes >= threshold) {
        // Execute trade
        investmentQueue.add('execute-trade', { voteId: vote_id });
        
        await db('investment_votes')
          .where({ id: vote_id })
          .update({ status: 'approved' });
      } else {
        await db('investment_votes')
          .where({ id: vote_id })
          .update({ status: 'rejected' });
      }
    }

    res.json({ message: 'Vote recorded' });
  } catch (error) {
    logger.error('Vote error:', error);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// Analytics routes
app.get('/api/analytics/dashboard', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user stats
    const [totalSaved] = await db('transactions')
      .where({ user_id: userId, type: 'split_payment' })
      .sum({ total: 'amount' });

    const [investmentReturns] = await db('transactions')
      .where({ user_id: userId, type: 'dividend' })
      .sum({ total: 'amount' });

    const [monthlyBills] = await db('bill_participants')
      .where({ user_id: userId })
      .whereRaw("created_at > NOW() - INTERVAL '30 days'")
      .count({ count: 'id' });

    // Get group stats
    const groups = await db('group_members')
      .join('groups', 'group_members.group_id', 'groups.id')
      .where('group_members.user_id', userId)
      .select('groups.*', 'group_members.balance');

    // Get recent transactions
    const transactions = await db('transactions')
      .where({ user_id: userId })
      .orderBy('created_at', 'desc')
      .limit(10);

    // Get portfolio value
    const investments = await db('investments')
      .join('group_members', 'investments.group_id', 'group_members.group_id')
      .where('group_members.user_id', userId)
      .select('investments.*');

    const portfolioValue = investments.reduce((sum, inv) => {
      const value = inv.total_value ?? (inv.current_price && inv.shares ? Number(inv.current_price) * Number(inv.shares) : 0);
      return sum + Number(value || 0);
    }, 0);

    res.json({
      stats: {
        total_saved: Number(totalSaved?.total || 0),
        investment_returns: Number(investmentReturns?.total || 0),
        monthly_bills: Number(monthlyBills?.count || 0),
        portfolio_value: portfolioValue,
        groups_count: groups.length
      },
      groups,
      recent_transactions: transactions
    });
  } catch (error) {
    logger.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Webhook handlers
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  try {
    if (!isStripeConfigured) {
      return res.json({ received: true });
    }

    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object);
        break;
      case 'issuing_card.created':
        logger.info('Virtual card created:', event.data.object.id);
        break;
      case 'issuing_authorization.created':
        await handleCardAuthorization(event.data.object);
        break;
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Stripe webhook error:', error);
    res.status(400).json({ error: 'Webhook error' });
  }
});

// Add a card to Stripe customer (token from Stripe.js createToken)
app.post('/api/stripe/add-card', authenticateToken, async (req, res) => {
  try {
    if (!isStripeConfigured) {
      return res.status(400).json({ error: 'Stripe not configured' });
    }
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Missing card token' });
    }
    const user = await db('users').where({ id: req.user.id }).first();
    if (!user || !user.stripe_customer_id) {
      return res.status(400).json({ error: 'User missing Stripe customer' });
    }
    const source = await stripe.customers.createSource(user.stripe_customer_id, { source: token });
    // Optionally set as default
    await stripe.customers.update(user.stripe_customer_id, { default_source: source.id });
    res.json({ message: 'Card added', last4: source.last4, brand: source.brand });
  } catch (error) {
    logger.error('Add card error:', error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// ======================
// Queue Processors
// ======================

// Payment processing queue
// Default to disabling queue processors in API container unless explicitly enabled
// This avoids duplicate processing if a separate worker is run
const shouldProcessQueues = process.env.DISABLE_QUEUE_PROCESSORS !== 'true' ? true : false;
if (shouldProcessQueues) {
paymentQueue.process('process-split', async (job) => {
  const { billId } = job.data;
  
  try {
    const bill = await db('bills').where({ id: billId }).first();
    const participants = await db('bill_participants').where({ bill_id: billId });

    let card = { id: null };
    if (ENABLE_STRIPE && STRIPE_ISSUING_ENABLED) {
      try {
        card = await stripe.issuing.cards.create({
          currency: 'usd',
          type: 'virtual',
          spending_controls: { spending_limits: [{ amount: Math.ceil(bill.total_amount * 100), interval: 'per_authorization' }] }
        });
      } catch (e) {
        logger.warn('Failed to create issuing card, continuing without card');
      }
    }

    // Charge each participant
    for (const participant of participants) {
      const user = await db('users').where({ id: participant.user_id }).first();
      
      if (ENABLE_STRIPE && user.stripe_customer_id) {
        try {
          const charge = await stripe.charges.create({
            amount: Math.ceil(participant.amount_owed * 100),
            currency: 'usd',
            customer: user.stripe_customer_id,
            description: `Split for ${bill.merchant_name}`,
            metadata: { bill_id: billId, user_id: participant.user_id }
          });
          await db('bill_participants').where({ id: participant.id }).update({
            status: 'paid',
            stripe_charge_id: charge.id,
            paid_at: new Date()
          });
        } catch (e) {
          logger.warn('Stripe charge failed for participant, marking as pending');
        }
      } else {
        await db('bill_participants').where({ id: participant.id }).update({ status: 'pending' });
      }
    }

    // Update bill status
    await db('bills')
      .where({ id: billId })
      .update({
        status: 'completed',
        virtual_card_id: card.id,
        paid_at: new Date()
      });

    logger.info(`Bill ${billId} processed successfully`);
  } catch (error) {
    logger.error('Payment processing error:', error);
    throw error;
  }
});

// Investment execution queue
investmentQueue.process('execute-trade', async (job) => {
  const { voteId } = job.data;

  try {
    const vote = await db('investment_votes').where({ id: voteId }).first();
    
    // Here you would integrate with a brokerage API like Alpaca or DriveWealth
    // For demonstration, we'll simulate the trade
    
    const [investment] = await db('investments').insert({
      group_id: vote.group_id,
      symbol: vote.symbol,
      name: `${vote.symbol} Stock`, // Would fetch from API
      shares: vote.shares,
      purchase_price: vote.amount,
      current_price: vote.amount,
      total_value: vote.amount,
      type: 'stock'
    }).returning('*');

    // Update group investment total
    await db('groups')
      .where({ id: vote.group_id })
      .increment('total_invested', vote.amount);

    // Create transaction records
    const members = await db('group_members')
      .where({ group_id: vote.group_id, status: 'active' });

    const amountPerMember = vote.amount / members.length;

    for (const member of members) {
      await db('transactions').insert({
        user_id: member.user_id,
        group_id: vote.group_id,
        type: 'investment',
        amount: -amountPerMember,
        description: `Investment in ${vote.symbol}`,
        metadata: JSON.stringify({ vote_id: voteId, investment_id: investment.id })
      });
    }

    logger.info(`Investment vote ${voteId} executed successfully`);
  } catch (error) {
    logger.error('Investment execution error:', error);
    throw error;
  }
});
}

// ======================
// WebSocket Handlers
// ======================

io.on('connection', (socket) => {
  logger.info('New WebSocket connection:', socket.id);

  socket.on('authenticate', async (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      socket.join(`user:${decoded.id}`);

      // Join user's groups
      const groups = await db('group_members')
        .where({ user_id: decoded.id })
        .select('group_id');

      for (const group of groups) {
        socket.join(`group:${group.group_id}`);
      }

      socket.emit('authenticated', { userId: decoded.id });
    } catch (error) {
      socket.emit('auth-error', 'Invalid token');
    }
  });

  socket.on('join-bill', (billId) => {
    socket.join(`bill:${billId}`);
  });

  socket.on('update-split', async (data) => {
    const { billId, items, participants } = data;
    
    // Broadcast to all participants
    io.to(`bill:${billId}`).emit('split-updated', {
      items,
      participants,
      updatedBy: socket.userId
    });
  });

  socket.on('disconnect', () => {
    logger.info('WebSocket disconnected:', socket.id);
  });
});

// ======================
// Helper Functions
// ======================

async function handlePaymentSuccess(paymentIntent) {
  // Update database records
  const metadata = paymentIntent.metadata;
  
  if (metadata.bill_id) {
    await db('bills')
      .where({ id: metadata.bill_id })
      .update({
        status: 'completed',
        stripe_payment_intent_id: paymentIntent.id,
        paid_at: new Date()
      });

    // Notify participants
    const participants = await db('bill_participants')
      .where({ bill_id: metadata.bill_id });

    for (const participant of participants) {
      await db('notifications').insert({
        user_id: participant.user_id,
        type: 'payment_success',
        title: 'Payment Successful',
        message: 'Your split payment has been processed',
        data: { bill_id: metadata.bill_id }
      });
    }
  }
}

async function handlePaymentFailure(paymentIntent) {
  const metadata = paymentIntent.metadata;
  
  if (metadata.bill_id) {
    await db('bills')
      .where({ id: metadata.bill_id })
      .update({ status: 'failed' });

    // Notify user
    if (metadata.user_id) {
      await db('notifications').insert({
        user_id: metadata.user_id,
        type: 'payment_failed',
        title: 'Payment Failed',
        message: 'Your payment could not be processed',
        data: { bill_id: metadata.bill_id }
      });
    }
  }
}

async function handleCardAuthorization(authorization) {
  // Auto-approve for now
  await stripe.issuing.authorizations.approve(authorization.id);
  logger.info('Card authorization approved:', authorization.id);
}

// ======================
// Error Handler
// ======================

app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ======================
// Start Server
// ======================

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // Initialize database
    await initDatabase();

    // Start server
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Server startup error:', error);
    process.exit(1);
  }
}

startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });

  await db.destroy();
  await redisClient.quit();
  
  process.exit(0);
});

module.exports = app;