// backend/migrations/001_initial_schema.js
// Complete database schema with all tables and relationships

exports.up = async function(knex) {
  // Enable UUID extension
  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  
  // Users table
  await knex.schema.createTable('users', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('email', 255).unique().notNullable();
    table.string('password_hash', 255).notNullable();
    table.string('name', 255).notNullable();
    table.string('phone', 20);
    table.string('avatar_url', 500);
    table.string('plaid_access_token', 500);
    table.string('stripe_customer_id', 255);
    table.string('stripe_account_id', 255);
    table.string('stripe_cardholder_id', 255);
    table.jsonb('settings').defaultTo('{}');
    table.jsonb('preferences').defaultTo('{}');
    table.boolean('email_verified').defaultTo(false);
    table.boolean('phone_verified').defaultTo(false);
    table.boolean('kyc_verified').defaultTo(false);
    table.string('referral_code', 20).unique();
    table.uuid('referred_by').references('id').inTable('users');
    table.decimal('lifetime_savings', 12, 2).defaultTo(0);
    table.decimal('lifetime_invested', 12, 2).defaultTo(0);
    table.integer('trust_score').defaultTo(100);
    table.timestamp('last_active_at');
    table.timestamps(true, true);
    
    // Indexes
    table.index('email');
    table.index('referral_code');
    table.index('created_at');
  });

  // Groups table
  await knex.schema.createTable('groups', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.string('name', 255).notNullable();
    table.text('description');
    table.string('avatar_url', 500);
    table.uuid('created_by').references('id').inTable('users');
    table.enum('type', ['friends', 'family', 'roommates', 'colleagues', 'investment_club', 'custom']).defaultTo('friends');
    table.enum('visibility', ['private', 'invite_only', 'public']).defaultTo('private');
    table.jsonb('settings').defaultTo('{}');
    table.jsonb('rules').defaultTo('{}'); // Automated rules for splitting
    table.decimal('total_split', 12, 2).defaultTo(0);
    table.decimal('total_invested', 12, 2).defaultTo(0);
    table.decimal('monthly_target', 10, 2);
    table.string('stripe_connected_account_id', 255);
    table.string('bank_account_id', 255);
    table.enum('investment_strategy', ['conservative', 'moderate', 'aggressive', 'custom']).defaultTo('moderate');
    table.decimal('investment_threshold', 10, 2).defaultTo(100); // Auto-invest when balance reaches this
    table.boolean('auto_invest_enabled').defaultTo(false);
    table.boolean('democratic_voting').defaultTo(true);
    table.integer('vote_threshold_percentage').defaultTo(60);
    table.string('invite_code', 20).unique();
    table.timestamp('last_activity_at');
    table.timestamps(true, true);
    
    table.index('created_by');
    table.index('type');
    table.index('invite_code');
  });

  // Group members table
  await knex.schema.createTable('group_members', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').references('id').inTable('groups').onDelete('CASCADE');
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.enum('role', ['owner', 'admin', 'member', 'viewer']).defaultTo('member');
    table.enum('status', ['active', 'invited', 'pending', 'suspended', 'removed']).defaultTo('active');
    table.decimal('balance', 10, 2).defaultTo(0);
    table.decimal('ownership_percentage', 5, 2); // For investment clubs
    table.jsonb('permissions').defaultTo('{}');
    table.decimal('monthly_contribution', 10, 2);
    table.boolean('auto_accept_splits').defaultTo(false);
    table.decimal('split_limit', 10, 2); // Max auto-accept amount
    table.timestamp('joined_at');
    table.timestamp('left_at');
    table.timestamps(true, true);
    
    table.unique(['group_id', 'user_id']);
    table.index('user_id');
    table.index('status');
  });

  // Bills/Splits table
  await knex.schema.createTable('bills', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').references('id').inTable('groups').onDelete('CASCADE');
    table.uuid('created_by').references('id').inTable('users');
    table.string('merchant_name', 255).notNullable();
    table.string('merchant_category', 100);
    table.decimal('subtotal', 10, 2).notNullable();
    table.decimal('tax_amount', 10, 2).defaultTo(0);
    table.decimal('tip_amount', 10, 2).defaultTo(0);
    table.decimal('total_amount', 10, 2).notNullable();
    table.string('currency', 3).defaultTo('USD');
    table.string('receipt_url', 500);
    table.jsonb('receipt_data').defaultTo('{}'); // OCR results
    table.jsonb('items').defaultTo('[]');
    table.jsonb('location').defaultTo('{}'); // GPS coordinates
    table.enum('status', ['draft', 'pending', 'processing', 'completed', 'failed', 'cancelled']).defaultTo('pending');
    table.enum('split_method', ['equal', 'percentage', 'amount', 'items']).defaultTo('items');
    table.string('virtual_card_id', 255);
    table.string('stripe_payment_intent_id', 255);
    table.string('stripe_charge_id', 255);
    table.boolean('is_recurring').defaultTo(false);
    table.string('recurring_schedule'); // cron expression
    table.timestamp('due_date');
    table.timestamp('paid_at');
    table.timestamps(true, true);
    
    table.index('group_id');
    table.index('created_by');
    table.index('status');
    table.index('created_at');
  });

  // Bill participants table
  await knex.schema.createTable('bill_participants', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('bill_id').references('id').inTable('bills').onDelete('CASCADE');
    table.uuid('user_id').references('id').inTable('users');
    table.decimal('amount_owed', 10, 2).notNullable();
    table.decimal('amount_paid', 10, 2).defaultTo(0);
    table.jsonb('items_claimed').defaultTo('[]');
    table.decimal('percentage_share', 5, 2);
    table.enum('status', ['pending', 'accepted', 'declined', 'paid', 'failed', 'refunded']).defaultTo('pending');
    table.enum('payment_method', ['bank', 'card', 'balance', 'venmo', 'paypal']).defaultTo('bank');
    table.string('stripe_charge_id', 255);
    table.string('external_payment_id', 255);
    table.text('notes');
    table.timestamp('accepted_at');
    table.timestamp('paid_at');
    table.timestamps(true, true);
    
    table.index('bill_id');
    table.index('user_id');
    table.index('status');
  });

  // Virtual cards table
  await knex.schema.createTable('virtual_cards', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').references('id').inTable('groups');
    table.uuid('bill_id').references('id').inTable('bills');
    table.uuid('user_id').references('id').inTable('users');
    table.string('stripe_card_id', 255);
    table.string('last4', 4);
    table.string('brand', 50);
    table.decimal('spending_limit', 10, 2).notNullable();
    table.decimal('amount_spent', 10, 2).defaultTo(0);
    table.jsonb('spending_controls').defaultTo('{}');
    table.enum('status', ['active', 'used', 'expired', 'cancelled', 'suspended']).defaultTo('active');
    table.timestamp('expires_at');
    table.timestamp('used_at');
    table.timestamps(true, true);
    
    table.index('group_id');
    table.index('bill_id');
    table.index('status');
  });

  // Investments table
  await knex.schema.createTable('investments', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').references('id').inTable('groups');
    table.string('symbol', 10).notNullable();
    table.string('name', 255).notNullable();
    table.enum('type', ['stock', 'etf', 'crypto', 'bond', 'mutual_fund', 'reit']).defaultTo('stock');
    table.decimal('shares', 12, 6).notNullable();
    table.decimal('average_cost', 10, 2).notNullable();
    table.decimal('current_price', 10, 2);
    table.decimal('total_value', 12, 2);
    table.decimal('total_return', 12, 2);
    table.decimal('total_return_percentage', 8, 2);
    table.jsonb('metadata').defaultTo('{}'); // Additional market data
    table.string('exchange', 50);
    table.string('broker_account_id', 255);
    table.timestamp('purchased_at');
    table.timestamp('sold_at');
    table.timestamps(true, true);
    
    table.index('group_id');
    table.index('symbol');
    table.index('type');
  });

  // Investment votes table
  await knex.schema.createTable('investment_votes', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').references('id').inTable('groups');
    table.uuid('proposed_by').references('id').inTable('users');
    table.enum('action', ['buy', 'sell', 'hold', 'rebalance']).notNullable();
    table.string('symbol', 10).notNullable();
    table.string('name', 255);
    table.decimal('amount', 10, 2);
    table.decimal('shares', 12, 6);
    table.decimal('target_price', 10, 2);
    table.text('reasoning');
    table.jsonb('votes').defaultTo('{}'); // {user_id: 'yes'|'no'|'abstain'}
    table.jsonb('comments').defaultTo('[]');
    table.integer('votes_required');
    table.integer('votes_yes').defaultTo(0);
    table.integer('votes_no').defaultTo(0);
    table.enum('status', ['pending', 'approved', 'rejected', 'executed', 'expired', 'cancelled']).defaultTo('pending');
    table.timestamp('executed_at');
    table.timestamp('expires_at');
    table.timestamps(true, true);
    
    table.index('group_id');
    table.index('proposed_by');
    table.index('status');
    table.index('expires_at');
  });

  // Transactions table
  await knex.schema.createTable('transactions', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users');
    table.uuid('group_id').references('id').inTable('groups');
    table.uuid('bill_id').references('id').inTable('bills');
    table.uuid('investment_id').references('id').inTable('investments');
    table.enum('type', [
      'split_payment', 'split_receipt', 'investment_buy', 'investment_sell', 
      'dividend', 'interest', 'deposit', 'withdrawal', 'transfer', 'fee', 'refund'
    ]).notNullable();
    table.enum('direction', ['debit', 'credit']).notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.string('currency', 3).defaultTo('USD');
    table.string('description', 500);
    table.jsonb('metadata').defaultTo('{}');
    table.string('external_id', 255); // Stripe, Plaid, etc.
    table.enum('status', ['pending', 'processing', 'completed', 'failed', 'reversed']).defaultTo('completed');
    table.decimal('running_balance', 12, 2);
    table.timestamp('processed_at');
    table.timestamps(true, true);
    
    table.index('user_id');
    table.index('group_id');
    table.index('type');
    table.index('status');
    table.index('created_at');
  });

  // Notifications table
  await knex.schema.createTable('notifications', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users').onDelete('CASCADE');
    table.enum('type', [
      'bill_created', 'bill_reminder', 'payment_received', 'payment_failed',
      'group_invite', 'member_joined', 'member_left',
      'investment_proposal', 'investment_executed', 'investment_return',
      'milestone_reached', 'weekly_summary', 'system_alert'
    ]).notNullable();
    table.string('title', 255).notNullable();
    table.text('message');
    table.jsonb('data').defaultTo('{}');
    table.boolean('read').defaultTo(false);
    table.boolean('email_sent').defaultTo(false);
    table.boolean('push_sent').defaultTo(false);
    table.boolean('sms_sent').defaultTo(false);
    table.enum('priority', ['low', 'medium', 'high', 'urgent']).defaultTo('medium');
    table.timestamp('read_at');
    table.timestamp('expires_at');
    table.timestamps(true, true);
    
    table.index('user_id');
    table.index('type');
    table.index('read');
    table.index('created_at');
  });

  // AI insights table
  await knex.schema.createTable('ai_insights', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users');
    table.uuid('group_id').references('id').inTable('groups');
    table.enum('type', [
      'spending_pattern', 'savings_opportunity', 'investment_recommendation',
      'group_health', 'fraud_alert', 'market_analysis'
    ]).notNullable();
    table.string('title', 255).notNullable();
    table.text('insight');
    table.jsonb('data').defaultTo('{}');
    table.decimal('confidence_score', 3, 2); // 0.00 to 1.00
    table.decimal('potential_savings', 10, 2);
    table.jsonb('actions').defaultTo('[]'); // Suggested actions
    table.boolean('acted_upon').defaultTo(false);
    table.timestamp('acted_at');
    table.timestamp('expires_at');
    table.timestamps(true, true);
    
    table.index('user_id');
    table.index('group_id');
    table.index('type');
    table.index('created_at');
  });

  // Recurring splits table
  await knex.schema.createTable('recurring_splits', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('group_id').references('id').inTable('groups');
    table.uuid('created_by').references('id').inTable('users');
    table.string('name', 255).notNullable();
    table.text('description');
    table.decimal('amount', 10, 2);
    table.enum('frequency', ['daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']).notNullable();
    table.string('schedule'); // Cron expression for complex schedules
    table.jsonb('participants').defaultTo('[]');
    table.enum('split_method', ['equal', 'percentage', 'custom']).defaultTo('equal');
    table.jsonb('split_configuration').defaultTo('{}');
    table.boolean('active').defaultTo(true);
    table.timestamp('next_run_at');
    table.timestamp('last_run_at');
    table.timestamp('starts_at');
    table.timestamp('ends_at');
    table.timestamps(true, true);
    
    table.index('group_id');
    table.index('active');
    table.index('next_run_at');
  });

  // Goals table
  await knex.schema.createTable('goals', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users');
    table.uuid('group_id').references('id').inTable('groups');
    table.string('name', 255).notNullable();
    table.text('description');
    table.enum('type', ['savings', 'investment', 'debt_reduction', 'purchase', 'custom']).notNullable();
    table.decimal('target_amount', 12, 2).notNullable();
    table.decimal('current_amount', 12, 2).defaultTo(0);
    table.decimal('monthly_contribution', 10, 2);
    table.timestamp('target_date');
    table.enum('status', ['active', 'paused', 'completed', 'abandoned']).defaultTo('active');
    table.jsonb('milestones').defaultTo('[]');
    table.timestamp('completed_at');
    table.timestamps(true, true);
    
    table.index('user_id');
    table.index('group_id');
    table.index('status');
    table.index('target_date');
  });

  // Disputes table
  await knex.schema.createTable('disputes', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('bill_id').references('id').inTable('bills');
    table.uuid('raised_by').references('id').inTable('users');
    table.uuid('disputed_with').references('id').inTable('users');
    table.enum('type', ['amount', 'items', 'payment', 'other']).notNullable();
    table.text('description').notNullable();
    table.jsonb('evidence').defaultTo('[]'); // Screenshots, receipts, etc.
    table.enum('status', ['open', 'in_review', 'resolved', 'escalated', 'closed']).defaultTo('open');
    table.text('resolution');
    table.uuid('resolved_by').references('id').inTable('users');
    table.timestamp('resolved_at');
    table.timestamps(true, true);
    
    table.index('bill_id');
    table.index('raised_by');
    table.index('status');
  });

  // Audit log table
  await knex.schema.createTable('audit_logs', table => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('user_id').references('id').inTable('users');
    table.string('action', 100).notNullable();
    table.string('entity_type', 50);
    table.uuid('entity_id');
    table.jsonb('old_values').defaultTo('{}');
    table.jsonb('new_values').defaultTo('{}');
    table.string('ip_address', 45);
    table.string('user_agent', 500);
    table.timestamp('created_at').defaultTo(knex.fn.now());
    
    table.index('user_id');
    table.index('entity_type');
    table.index('entity_id');
    table.index('created_at');
  });
};

exports.down = async function(knex) {
  // Drop all tables in reverse order
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('disputes');
  await knex.schema.dropTableIfExists('goals');
  await knex.schema.dropTableIfExists('recurring_splits');
  await knex.schema.dropTableIfExists('ai_insights');
  await knex.schema.dropTableIfExists('notifications');
  await knex.schema.dropTableIfExists('transactions');
  await knex.schema.dropTableIfExists('investment_votes');
  await knex.schema.dropTableIfExists('investments');
  await knex.schema.dropTableIfExists('virtual_cards');
  await knex.schema.dropTableIfExists('bill_participants');
  await knex.schema.dropTableIfExists('bills');
  await knex.schema.dropTableIfExists('group_members');
  await knex.schema.dropTableIfExists('groups');
  await knex.schema.dropTableIfExists('users');
};