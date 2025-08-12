// ===========================
// seeds/001_demo_data.js - Sample data for testing
// ===========================

exports.seed = async function(knex) {
  // Clear existing data
  await knex('transactions').del();
  await knex('investments').del();
  await knex('bill_participants').del();
  await knex('bills').del();
  await knex('group_members').del();
  await knex('groups').del();
  await knex('users').del();

  // Insert demo users
  const users = await knex('users').insert([
    {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'demo@example.com',
      password_hash: '$2a$10$YKx0b0mrZFKc6BOqlRs2QeZmjFBjvFw5w7GWZVN6YzV8NgdGVWAKO', // password: demo123
      name: 'Demo User',
      phone: '+14155551234',
      email_verified: true,
      referral_code: 'DEMO2025'
    },
    {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'alice@example.com',
      password_hash: '$2a$10$YKx0b0mrZFKc6BOqlRs2QeZmjFBjvFw5w7GWZVN6YzV8NgdGVWAKO',
      name: 'Alice Johnson',
      email_verified: true
    },
    {
      id: '33333333-3333-3333-3333-333333333333',
      email: 'bob@example.com',
      password_hash: '$2a$10$YKx0b0mrZFKc6BOqlRs2QeZmjFBjvFw5w7GWZVN6YzV8NgdGVWAKO',
      name: 'Bob Smith',
      email_verified: true
    }
  ]).returning('*');

  // Insert demo groups
  const groups = await knex('groups').insert([
    {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      name: 'Dinner Squad',
      description: 'Weekly dinner group',
      created_by: users[0].id,
      type: 'friends',
      total_split: 1250.50,
      total_invested: 500.00,
      investment_strategy: 'moderate',
      invite_code: 'DINNER123'
    },
    {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      name: 'Roommates',
      description: 'Shared apartment expenses',
      created_by: users[0].id,
      type: 'roommates',
      total_split: 3420.75,
      total_invested: 1200.00,
      investment_strategy: 'conservative',
      invite_code: 'ROOM456'
    }
  ]).returning('*');

  // Add members to groups
  await knex('group_members').insert([
    {
      group_id: groups[0].id,
      user_id: users[0].id,
      role: 'owner',
      status: 'active',
      balance: 125.50
    },
    {
      group_id: groups[0].id,
      user_id: users[1].id,
      role: 'member',
      status: 'active',
      balance: 87.25
    },
    {
      group_id: groups[0].id,
      user_id: users[2].id,
      role: 'member',
      status: 'active',
      balance: 63.40
    },
    {
      group_id: groups[1].id,
      user_id: users[0].id,
      role: 'owner',
      status: 'active',
      balance: 250.00
    },
    {
      group_id: groups[1].id,
      user_id: users[1].id,
      role: 'admin',
      status: 'active',
      balance: 175.50
    }
  ]);

  // Insert sample bills
  const bills = await knex('bills').insert([
    {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      group_id: groups[0].id,
      created_by: users[0].id,
      merchant_name: 'Olive Garden',
      merchant_category: 'restaurant',
      subtotal: 72.50,
      tax_amount: 6.16,
      tip_amount: 13.05,
      total_amount: 91.71,
      items: JSON.stringify([
        { id: 1, name: 'Chicken Alfredo', price: 18.99 },
        { id: 2, name: 'Caesar Salad', price: 8.99 },
        { id: 3, name: 'Breadsticks', price: 5.99 },
        { id: 4, name: 'Tiramisu', price: 7.99 },
        { id: 5, name: 'Wine', price: 12.50 },
        { id: 6, name: 'Soda', price: 3.99 }
      ]),
      status: 'completed',
      split_method: 'items',
      paid_at: new Date()
    }
  ]).returning('*');

  // Add bill participants
  await knex('bill_participants').insert([
    {
      bill_id: bills[0].id,
      user_id: users[0].id,
      amount_owed: 35.47,
      amount_paid: 35.47,
      items_claimed: JSON.stringify([1, 3]),
      status: 'paid',
      paid_at: new Date()
    },
    {
      bill_id: bills[0].id,
      user_id: users[1].id,
      amount_owed: 28.12,
      amount_paid: 28.12,
      items_claimed: JSON.stringify([2, 4]),
      status: 'paid',
      paid_at: new Date()
    },
    {
      bill_id: bills[0].id,
      user_id: users[2].id,
      amount_owed: 28.12,
      amount_paid: 28.12,
      items_claimed: JSON.stringify([5, 6]),
      status: 'paid',
      paid_at: new Date()
    }
  ]);

  // Insert sample transactions
  await knex('transactions').insert([
    {
      user_id: users[0].id,
      group_id: groups[0].id,
      bill_id: bills[0].id,
      type: 'split_payment',
      direction: 'debit',
      amount: 35.47,
      description: 'Split payment for Olive Garden',
      status: 'completed'
    },
    {
      user_id: users[0].id,
      group_id: groups[0].id,
      type: 'investment_buy',
      direction: 'debit',
      amount: 100.00,
      description: 'Monthly investment contribution',
      status: 'completed'
    }
  ]);

  // Insert sample investments
  await knex('investments').insert([
    {
      group_id: groups[0].id,
      symbol: 'VTI',
      name: 'Vanguard Total Stock Market ETF',
      type: 'etf',
      shares: 2.345,
      average_cost: 213.25,
      current_price: 225.50,
      total_value: 528.80,
      total_return: 28.80,
      total_return_percentage: 5.76
    },
    {
      group_id: groups[1].id,
      symbol: 'AAPL',
      name: 'Apple Inc.',
      type: 'stock',
      shares: 5,
      average_cost: 175.50,
      current_price: 192.75,
      total_value: 963.75,
      total_return: 86.25,
      total_return_percentage: 9.82
    }
  ]);

  console.log('Demo data seeded successfully');
};