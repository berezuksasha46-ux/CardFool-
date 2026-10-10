const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://your-supabase-url.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let useMemoryFallback = false;
const memoryUsers = new Map();
const memoryFriends = new Map();

async function dbGetOrCreateUser(telegramId, userData) {
  const uniqueId = Math.floor(100000 + Math.random() * 900000).toString();

  if (useMemoryFallback) {
    if (!memoryUsers.has(telegramId)) {
      memoryUsers.set(telegramId, {
        telegram_id: telegramId,
        unique_id: uniqueId,
        username: userData.username || 'Player',
        first_name: userData.first_name || 'Gamer',
        photo_url: userData.photo_url || null,
        stars_balance: 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null,
        referrer_id: userData.referrer_id || null
      });
    }
    return memoryUsers.get(telegramId);
  }

  try {
    const { data, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (error && error.code === 'PGRST116') {
      const newUser = {
        telegram_id: telegramId,
        unique_id: uniqueId,
        username: userData.username || 'Player',
        first_name: userData.first_name || 'Gamer',
        photo_url: userData.photo_url || null,
        stars_balance: 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null,
        referrer_id: userData.referrer_id || null
      };
      const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
      if (insertErr) throw insertErr;
      return inserted;
    } else if (error) throw error;
    return data;
  } catch (err) {
    useMemoryFallback = true;
    return dbGetOrCreateUser(telegramId, userData);
  }
}

async function dbUpdateUser(telegramId, updateFields) {
  if (useMemoryFallback) {
    const user = memoryUsers.get(telegramId);
    if (user) Object.assign(user, updateFields);
    return user;
  }
  try {
    const { data, error } = await supabase.from('users').update(updateFields).eq('telegram_id', telegramId).select().single();
    if (error) throw error;
    return data;
  } catch (err) {
    useMemoryFallback = true;
    return dbUpdateUser(telegramId, updateFields);
  }
}

async function dbGetLeaderboard() {
  if (useMemoryFallback) {
    return Array.from(memoryUsers.values()).sort((a, b) => b.wins - a.wins).slice(0, 50);
  }
  try {
    const { data, error } = await supabase.from('users').select('telegram_id, unique_id, username, first_name, photo_url, stars_balance, wins, losses, level').order('wins', { ascending: false }).limit(50);
    if (error) throw error;
    return data;
  } catch (err) {
    useMemoryFallback = true;
    return dbGetLeaderboard();
  }
}
const tables = new Map();
const activeGames = new Map();

function createDeck(deckSize) {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks24 = ['9', '10', 'J', 'Q', 'K', 'A'];
  const ranks36 = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const ranks = deckSize === 24 ? ranks24 : ranks36;
  const rankValues = { '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };

  let deck = [];
  for (let s of suits) {
    for (let r of ranks) {
      deck.push({ id: s + r, suit: s, rank: r, value: rankValues[r] });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('auth', async (data) => {
    const { telegram_id, username, first_name, photo_url, referrer_id } = data;
    if (!telegram_id) return;
    currentUser = await dbGetOrCreateUser(telegram_id, { username, first_name, photo_url, referrer_id });
    socket._telegram_id = telegram_id;
    socket.emit('auth_success', currentUser);
    emitLobbies();
  });

  socket.on('set_socket_user', (telegram_id) => { socket._telegram_id = telegram_id; });
  socket.on('get_lobbies', () => { emitLobbies(socket); });

  socket.on('get_friends', async (data) => {
    const tId = data?.telegram_id || currentUser?.telegram_id;
    if (!tId) return;

    if (useMemoryFallback) {
      const friendIds = memoryFriends.get(tId) || new Set();
      const friendsList = [];
      for (let fId of friendIds) {
        if (memoryUsers.has(fId)) friendsList.push(memoryUsers.get(fId));
      }
      socket.emit('friends_list', { friends: friendsList });
      return;
    }

    try {
      const { data: friends } = await supabase.from('users').select('*').eq('referrer_id', Number(tId));
      socket.emit('friends_list', { friends: friends || [] });
    } catch (e) {
      socket.emit('friends_list', { friends: [] });
    }
  });

  socket.on('add_friend_by_unique_id', async (data) => {
    const { uniqueId } = data;
    if (!currentUser || !uniqueId) return;

    let targetUser = null;
    if (useMemoryFallback) {
      for (let u of memoryUsers.values()) {
        if (u.unique_id === uniqueId) { targetUser = u; break; }
      }
    } else {
      const { data, error } = await supabase.from('users').select('*').eq('unique_id', uniqueId).single();
      if (!error) targetUser = data;
    }

    if (!targetUser) {
      socket.emit('error_message', 'Игрок с таким ID не найден!');
      return;
    }

    if (String(targetUser.telegram_id) === String(currentUser.telegram_id)) {
      socket.emit('error_message', 'Нельзя добавить самого себя!');
      return;
    }

    if (useMemoryFallback) {
      if (!memoryFriends.has(currentUser.telegram_id)) memoryFriends.set(currentUser.telegram_id, new Set());
      memoryFriends.get(currentUser.telegram_id).add(targetUser.telegram_id);
    } else {
      await dbUpdateUser(targetUser.telegram_id, { referrer_id: currentUser.telegram_id });
    }

    socket.emit('error_message', `Игрок ${targetUser.first_name || targetUser.username} успешно добавлен в друзья!`);
    socket.emit('friends_list', { friends: [targetUser] });
  });

  socket.on('claim_daily', async () => {
    if (!currentUser) return;
    const now = new Date();
    const lastClaim = currentUser.last_daily_claim ? new Date(currentUser.last_daily_claim) : null;
    if (lastClaim && (now - lastClaim) < 24 * 60 * 60 * 1000) {
      socket.emit('daily_error', { message: 'Ежедневный бонус уже получен сегодня!' });
      return;
    }
    currentUser.stars_balance = (currentUser.stars_balance || 0) + 10;
    currentUser.last_daily_claim = now.toISOString();
    await dbUpdateUser(currentUser.telegram_id, { stars_balance: currentUser.stars_balance, last_daily_claim: currentUser.last_daily_claim });
    socket.emit('auth_success', currentUser);
    socket.emit('daily_success', { stars_balance: currentUser.stars_balance });
  });
  socket.on('create_table', async (config) => {
    if (!currentUser && socket._telegram_id) currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    if (!currentUser) return;

    const { mode, deckSize, stake } = config;
    if (currentUser.stars_balance < stake) {
      socket.emit('error_message', 'Недостаточно звезд на балансе!');
      return;
    }

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    const newTable = {
      id: tableId,
      hostId: currentUser.telegram_id,
      hostName: currentUser.first_name || currentUser.username,
      mode: mode || 'podkidnoy',
      deckSize: Number(deckSize) || 36,
      stake: Number(stake) || 10,
      status: 'waiting'
    };

    tables.set(tableId, newTable);
    socket.join(tableId);
    socket.emit('table_created', tableId);
    emitLobbies();
  });

  socket.on('join_table', async (data) => {
    if (!currentUser && socket._telegram_id) currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    if (!currentUser) return;

    const tableId = typeof data === 'object' ? (data.tableId || data.gameId) : data;
    const table = tables.get(tableId);

    if (activeGames.has(tableId)) {
      socket.join(tableId);
      broadcastGameState(activeGames.get(tableId));
      return;
    }

    if (!table) {
      socket.emit('error_message', 'Стол не найден или уже запущен!');
      return;
    }

    if (table.hostId === currentUser.telegram_id) {
      socket.join(tableId);
      return;
    }

    table.status = 'playing';
    const deck = createDeck(table.deckSize);
    const trumpCard = deck[deck.length - 1];
    const p1Hand = deck.splice(0, 6);
    const p2Hand = deck.splice(0, 6);
    const hostUser = await dbGetOrCreateUser(table.hostId, {});

    const gameState = {
      gameId: tableId,
      tableId,
      mode: table.mode,
      stake: table.stake,
      deck,
      trumpCard,
      players: [
        { id: hostUser.telegram_id, name: hostUser.first_name || hostUser.username, level: hostUser.level || 1, hand: p1Hand, socketId: null },
        { id: currentUser.telegram_id, name: currentUser.first_name || currentUser.username, level: currentUser.level || 1, hand: p2Hand, socketId: socket.id }
      ],
      attackerIndex: 0,
      defenderIndex: 1,
      tableCards: [],
      status: 'playing'
    };

    for (let s of io.sockets.sockets.values()) {
      if (s._telegram_id == hostUser.telegram_id) {
        gameState.players[0].socketId = s.id;
        s.join(tableId);
      }
    }

    socket.join(tableId);
    activeGames.set(tableId, gameState);
    tables.delete(tableId);
    emitLobbies();
    broadcastGameState(gameState);
  });

  socket.on('game_action', async (data) => {
    if (!currentUser && socket._telegram_id) currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    handleGameAction(socket, data);
  });

  async function emitLobbies(targetSocket = io) {
    targetSocket.emit('lobbies_list', { tables: Array.from(tables.values()) });
  }
});

function broadcastGameState(game) {
  game.players.forEach((player, idx) => {
    const isAttacker = game.attackerIndex === idx;
    const isDefender = game.defenderIndex === idx;
    const sock = io.sockets.sockets.get(player.socketId);

    if (sock) {
      sock.emit('game_state', {
        gameId: game.gameId,
        deckCount: game.deck.length,
        trumpCard: game.trumpCard,
        tableCards: game.tableCards,
        players: game.players.map(p => ({ name: p.name, handCount: p.hand.length }))
      });
      sock.emit('your_hand', player.hand);
      sock.emit('is_turn_data', {
        isMyTurn: isAttacker || (isDefender && game.tableCards.some(tc => !tc.defend)),
        isAttacker: isAttacker
      });
    }
  });
}

function replenishHands(game) {
  [game.attackerIndex, game.defenderIndex].forEach(idx => {
    while (game.players[idx].hand.length < 6 && game.deck.length > 0) {
      game.players[idx].hand.push(game.deck.pop());
    }
  });
}

async function handleGameAction(socket, data) {
  const { gameId, action, cardId } = data;
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'playing') return;

  const playerIdx = game.players.findIndex(p => p.socketId === socket.id);
  if (playerIdx === -1) return;

  const isAttacker = game.attackerIndex === playerIdx;
  const isDefender = game.defenderIndex === playerIdx;

  if (action === 'play_card') {
    const hand = game.players[playerIdx].hand;
    const cardIndex = hand.findIndex(c => c.id === cardId);
    if (cardIndex === -1) return;
    const card = hand[cardIndex];

    if (isAttacker) {
      if (game.tableCards.length > 0) {
        const ranksOnTable = new Set();
        game.tableCards.forEach(tc => {
          ranksOnTable.add(tc.attack.rank);
          if (tc.defend) ranksOnTable.add(tc.defend.rank);
        });
        if (!ranksOnTable.has(card.rank)) return;
      }

      const undefendedCount = game.tableCards.filter(tc => !tc.defend).length;
      if (undefendedCount >= game.players[game.defenderIndex].hand.length) return;

      hand.splice(cardIndex, 1);
      game.tableCards.push({ attack: card, defend: null });
      broadcastGameState(game);
    } 
    else if (isDefender) {
      const activeAttack = game.tableCards.find(tc => !tc.defend);
      if (!activeAttack) return;

      const isValid = (card.suit === activeAttack.attack.suit && card.value > activeAttack.attack.value) ||
                      (card.suit === game.trumpCard.suit && activeAttack.attack.suit !== game.trumpCard.suit);

      if (isValid) {
        hand.splice(cardIndex, 1);
        activeAttack.defend = card;
        broadcastGameState(game);
      }
    }
  }
  else if (action === 'bito' && isAttacker) {
    if (game.tableCards.length > 0 && game.tableCards.every(tc => tc.defend)) {
      game.tableCards = [];
      replenishHands(game);
      const temp = game.attackerIndex;
      game.attackerIndex = game.defenderIndex;
      game.defenderIndex = temp;
      broadcastGameState(game);
    }
  }
  else if (action === 'take' && isDefender) {
    const cardsToTake = [];
    game.tableCards.forEach(tc => {
      cardsToTake.push(tc.attack);
      if (tc.defend) cardsToTake.push(tc.defend);
    });
    game.players[playerIdx].hand.push(...cardsToTake);
    game.tableCards = [];
    replenishHands(game);
    broadcastGameState(game);
  }
}

app.get('/api/leaderboard', async (req, res) => { res.json(await dbGetLeaderboard()); });
server.listen(3000, () => { console.log('Server running on port 3000'); });
