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

function generateUniqueId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function dbGetOrCreateUser(telegramId, userData) {
  const cleanName = userData.first_name || (userData.username ? userData.username.split('@')[0] : 'Игрок');

  if (useMemoryFallback) {
    if (!memoryUsers.has(telegramId)) {
      memoryUsers.set(telegramId, {
        telegram_id: telegramId,
        unique_id: generateUniqueId(),
        username: userData.username || cleanName,
        first_name: cleanName,
        photo_url: userData.photo_url || null,
        stars_balance: 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null
      });
    }
    return memoryUsers.get(telegramId);
  }

  try {
    let { data, error } = await supabase.from('users').select('*').eq('telegram_id', telegramId).single();
    if (error && error.code === 'PGRST116') {
      const newUser = {
        telegram_id: telegramId,
        unique_id: generateUniqueId(),
        username: userData.username || cleanName,
        first_name: cleanName,
        photo_url: userData.photo_url || null,
        stars_balance: 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null
      };
      const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
      if (insertErr) throw insertErr;
      return inserted;
    } else if (error) throw error;

    // Если ID уже есть в базе — жестко закрепляем его и больше никогда не меняем
    if (!data.unique_id) {
      const fixedId = generateUniqueId();
      await dbUpdateUser(telegramId, { unique_id: fixedId });
      data.unique_id = fixedId;
    }

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
    return Array.from(memoryUsers.values()).sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, 50);
  }
  try {
    const { data, error } = await supabase.from('users').select('telegram_id, unique_id, username, first_name, photo_url, stars_balance, wins, losses, level').order('wins', { ascending: false }).limit(50);
    if (error) throw error;
    return data || [];
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
    const { telegram_id, username, first_name, photo_url } = data;
    if (!telegram_id) return;
    currentUser = await dbGetOrCreateUser(telegram_id, { username, first_name, photo_url });
    socket._telegram_id = telegram_id;
    socket.emit('auth_success', currentUser);
    emitLobbies();
  });

  socket.on('set_socket_user', (telegram_id) => { socket._telegram_id = telegram_id; });
  socket.on('get_lobbies', () => { emitLobbies(socket); });

  socket.on('get_friends', async (data) => {
    const tId = data?.telegram_id || currentUser?.telegram_id;
    if (!tId) return;

    try {
      const { data: relations } = await supabase.from('friends').select('friend_id').eq('user_id', tId);
      let friendsList = [];
      if (relations && relations.length > 0) {
        const friendIds = relations.map(r => r.friend_id);
        const { data: fData } = await supabase.from('users').select('*').in('telegram_id', friendIds);
        friendsList = fData || [];
      }

      const { data: reqs } = await supabase.from('friend_requests').select('sender_id').eq('receiver_id', tId).eq('status', 'pending');
      let requestsList = [];
      if (reqs && reqs.length > 0) {
        const senderIds = reqs.map(r => r.sender_id);
        const { data: sData } = await supabase.from('users').select('*').in('telegram_id', senderIds);
        requestsList = sData || [];
      }

      socket.emit('friends_list', { friends: friendsList, requests: requestsList });
    } catch (e) {
      socket.emit('friends_list', { friends: [], requests: [] });
    }
  });

  socket.on('add_friend_by_unique_id', async (data) => {
    const { uniqueId } = data;
    if (!currentUser || !uniqueId) return;

    try {
      const { data: targetUser, error } = await supabase.from('users').select('*').eq('unique_id', uniqueId).single();
      if (error || !targetUser) {
        socket.emit('error_message', 'Игрок с таким ID не найден!');
        return;
      }

      if (String(targetUser.telegram_id) === String(currentUser.telegram_id)) {
        socket.emit('error_message', 'Нельзя отправить заявку самому себе!');
        return;
      }

      const { data: existingFriend } = await supabase.from('friends').select('*').eq('user_id', currentUser.telegram_id).eq('friend_id', targetUser.telegram_id).single();
      if (existingFriend) {
        socket.emit('error_message', 'Вы уже друзья с этим игроком!');
        return;
      }

      await supabase.from('friend_requests').upsert([
        { sender_id: currentUser.telegram_id, receiver_id: targetUser.telegram_id, status: 'pending' }
      ], { onConflict: ['sender_id', 'receiver_id'] });

      socket.emit('error_message', `Заявка отправлена игроку ${targetUser.first_name || targetUser.username}!`);
    } catch (e) {
      socket.emit('error_message', 'Ошибка при отправке заявки.');
    }
  });

  socket.on('respond_friend_request', async (data) => {
    const { senderId, action } = data;
    if (!currentUser || !senderId) return;

    try {
      if (action === 'accept') {
        await supabase.from('friends').insert([
          { user_id: currentUser.telegram_id, friend_id: senderId },
          { user_id: senderId, friend_id: currentUser.telegram_id }
        ]);
      }
      await supabase.from('friend_requests').delete().eq('sender_id', senderId).eq('receiver_id', currentUser.telegram_id);

      socket.emit('error_message', action === 'accept' ? 'Заявка принята!' : 'Заявка отклонена.');
      socket.emit('get_friends', { telegram_id: currentUser.telegram_id });
    } catch (e) {
      socket.emit('error_message', 'Ошибка обработки заявки.');
    }
  });

  socket.on('leave_waiting_table', (tableId) => {
    if (!currentUser) return;
    const table = tables.get(tableId);
    if (table && String(table.hostId) === String(currentUser.telegram_id)) {
      tables.delete(tableId);
      socket.leave(tableId);
      socket.emit('table_deleted');
      socket.emit('error_message', 'Вы вышли из стола!');
      emitLobbies();
    }
  });
  socket.on('create_table', async (config) => {
    if (!currentUser && socket._telegram_id) currentUser = await dbGetOrCreateUser(socket._telegram_id, {});
    if (!currentUser) return;

    for (let [tId, t] of tables.entries()) {
      if (String(t.hostId) === String(currentUser.telegram_id)) {
        socket.emit('table_created', tId);
        return;
      }
    }

    const { mode, deckSize, stake } = config;
    const currentStake = Number(stake) || 10;

    if ((currentUser.stars_balance || 0) < currentStake) {
      socket.emit('error_message', 'Недостаточно звезд на балансе!');
      return;
    }

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    const newTable = {
      id: tableId,
      hostId: String(currentUser.telegram_id),
      hostName: currentUser.first_name || currentUser.username,
      mode: mode || 'podkidnoy',
      deckSize: Number(deckSize) || 36,
      stake: currentStake,
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
      const existingGame = activeGames.get(tableId);
      const player = existingGame.players.find(p => String(p.id) === String(currentUser.telegram_id));
      if (player) player.socketId = socket.id;
      
      socket.join(tableId);
      broadcastGameState(existingGame);
      return;
    }

    if (!table) {
      socket.emit('error_message', 'Стол не найден или уже закрыт!');
      return;
    }

    if (String(table.hostId) === String(currentUser.telegram_id)) {
      socket.emit('table_created', tableId);
      return;
    }

    if ((currentUser.stars_balance || 0) < table.stake) {
      socket.emit('error_message', 'Недостаточно звезд для входа!');
      return;
    }

    // Снимаем ставки со счетов обоих игроков сразу при старте игры
    const hostUser = await dbGetOrCreateUser(table.hostId, {});
    
    hostUser.stars_balance = Math.max(0, (hostUser.stars_balance || 0) - table.stake);
    currentUser.stars_balance = Math.max(0, (currentUser.stars_balance || 0) - table.stake);

    await dbUpdateUser(hostUser.telegram_id, { stars_balance: hostUser.stars_balance });
    await dbUpdateUser(currentUser.telegram_id, { stars_balance: currentUser.stars_balance });

    table.status = 'playing';
    const deck = createDeck(table.deckSize);
    const trumpCard = deck[deck.length - 1];
    const p1Hand = deck.splice(0, 6);
    const p2Hand = deck.splice(0, 6);

    const gameState = {
      gameId: tableId,
      tableId,
      mode: table.mode,
      stake: table.stake,
      deck,
      trumpCard,
      players: [
        { id: String(hostUser.telegram_id), name: hostUser.first_name || hostUser.username, level: hostUser.level || 1, hand: p1Hand, socketId: null },
        { id: String(currentUser.telegram_id), name: currentUser.first_name || currentUser.username, level: currentUser.level || 1, hand: p2Hand, socketId: socket.id }
      ],
      attackerIndex: 0,
      defenderIndex: 1,
      tableCards: [],
      status: 'playing'
    };

    for (let s of io.sockets.sockets.values()) {
      if (String(s._telegram_id) === String(hostUser.telegram_id)) {
        gameState.players[0].socketId = s.id;
        s.join(tableId);
        s.emit('auth_success', hostUser);
      }
    }

    socket.join(tableId);
    socket.emit('auth_success', currentUser);
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

async function checkGameEnd(game) {
  if (game.deck.length > 0) return;

  const p0Empty = game.players[0].hand.length === 0;
  const p1Empty = game.players[1].hand.length === 0;

  if (p0Empty || p1Empty) {
    game.status = 'ended';
    let winnerIdx = p0Empty ? 0 : 1;
    let loserIdx = p0Empty ? 1 : 0;

    const winner = game.players[winnerIdx];
    const loser = game.players[loserIdx];

    // Расчет банка: ставка * 2 минус 10% комиссии
    const totalPot = game.stake * 2;
    const prize = Math.round(totalPot * 0.9);

    // Обновляем статистику в БД
    const wUser = await dbGetOrCreateUser(winner.id, {});
    const lUser = await dbGetOrCreateUser(loser.id, {});

    wUser.stars_balance = (wUser.stars_balance || 0) + prize;
    wUser.wins = (wUser.wins || 0) + 1;
    lUser.losses = (lUser.losses || 0) + 1;

    await dbUpdateUser(wUser.telegram_id, { stars_balance: wUser.stars_balance, wins: wUser.wins });
    await dbUpdateUser(lUser.telegram_id, { losses: lUser.losses });

    // Оповещаем игроков об окончании партии
    const wSock = io.sockets.sockets.get(winner.socketId);
    const lSock = io.sockets.sockets.get(loser.socketId);

    if (wSock) {
      wSock.emit('game_over', { won: true, prize, stars_balance: wUser.stars_balance });
      wSock.emit('auth_success', wUser);
    }
    if (lSock) {
      lSock.emit('game_over', { won: false, prize: 0, stars_balance: lUser.stars_balance });
      lSock.emit('auth_success', lUser);
    }

    activeGames.delete(game.gameId);
  }
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
      await checkGameEnd(game);
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
        await checkGameEnd(game);
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
      await checkGameEnd(game);
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
    await checkGameEnd(game);
  }
}

app.get('/api/leaderboard', async (req, res) => { res.json(await dbGetLeaderboard()); });
server.listen(3000, () => { console.log('Server running on port 3000'); });
