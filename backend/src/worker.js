// Background worker for queues
const dotenv = require('dotenv');
dotenv.config();

const Bull = require('bull');
const knex = require('knex');
const stripeSdk = require('stripe');
const twilio = require('twilio');
const winston = require('winston');

const db = knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 }
});

const stripe = process.env.STRIPE_SECRET_KEY ? stripeSdk(process.env.STRIPE_SECRET_KEY) : null;
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const paymentQueue = new Bull('payment-processing', process.env.REDIS_URL);
const investmentQueue = new Bull('investment-processing', process.env.REDIS_URL);
const notificationQueue = new Bull('notifications', process.env.REDIS_URL);

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console({ format: winston.format.simple() })]
});

paymentQueue.process('process-split', async (job) => {
  const { billId } = job.data;
  try {
    const bill = await db('bills').where({ id: billId }).first();
    const participants = await db('bill_participants').where({ bill_id: billId });

    for (const participant of participants) {
      const user = await db('users').where({ id: participant.user_id }).first();
      if (stripe && user.stripe_customer_id) {
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
          logger.warn(`Charge failed for participant ${participant.user_id}`);
        }
      }
    }

    await db('bills').where({ id: billId }).update({ status: 'completed', paid_at: new Date() });
    logger.info(`Bill ${billId} processed successfully`);
  } catch (err) {
    logger.error('Worker process-split error:', err);
    throw err;
  }
});
investmentQueue.process('execute-trade', async (job) => {
  const { voteId } = job.data;
  try {
    const vote = await db('investment_votes').where({ id: voteId }).first();
    if (!vote) return;

    const [investment] = await db('investments').insert({
      group_id: vote.group_id,
      symbol: vote.symbol,
      name: `${vote.symbol} Stock`,
      shares: vote.shares,
      average_cost: vote.amount,
      current_price: vote.amount,
      total_value: vote.amount,
      type: 'stock'
    }).returning('*');

    const members = await db('group_members').where({ group_id: vote.group_id, status: 'active' });
    const amountPerMember = (Number(vote.amount) || 0) / Math.max(members.length, 1);
    for (const member of members) {
      await db('transactions').insert({
        user_id: member.user_id,
        group_id: vote.group_id,
        investment_id: investment.id,
        type: 'investment_buy',
        direction: 'debit',
        amount: amountPerMember,
        description: `Investment in ${vote.symbol}`
      });
    }

    await db('groups').where({ id: vote.group_id }).increment('total_invested', vote.amount);
    await db('investment_votes').where({ id: voteId }).update({ status: 'executed', executed_at: new Date() });
    logger.info(`Executed trade for vote ${voteId}`);
  } catch (err) {
    logger.error('Worker execute-trade error:', err);
    throw err;
  }
});

notificationQueue.process('welcome', async (job) => {
  const { userId, email, name } = job.data;
  try {
    await db('notifications').insert({
      user_id: userId,
      type: 'milestone_reached',
      title: 'Welcome to Community Capital',
      message: 'We are excited to have you on board!'
    });
    if (twilioClient) {
      // optional SMS hook if phone number on file
      const user = await db('users').where({ id: userId }).first();
      if (user && user.phone) {
        await twilioClient.messages.create({
          to: user.phone,
          from: process.env.TWILIO_FROM_NUMBER || '+15005550006',
          body: `Welcome ${name || ''}! Thanks for joining Community Capital.`
        });
      }
    }
  } catch (err) {
    logger.warn('Notification welcome failed', err);
  }
});

investmentQueue.process('execute-trade', async (job) => {
  const { voteId } = job.data;
  try {
    const vote = await db('investment_votes').where({ id: voteId }).first();
    if (!vote) return;
    const [investment] = await db('investments').insert({
      group_id: vote.group_id,
      symbol: vote.symbol,
      name: `${vote.symbol} Stock`,
      shares: vote.shares,
      average_cost: vote.amount,
      current_price: vote.amount,
      total_value: vote.amount,
      type: 'stock'
    }).returning('*');
    logger.info(`Trade executed for vote ${voteId}, investment ${investment.id}`);
  } catch (err) {
    logger.error('Worker execute-trade error:', err);
    throw err;
  }
});


