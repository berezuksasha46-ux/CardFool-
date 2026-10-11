const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const querystring = require('querystring');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://your-supabase-url.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'your-supabase-key';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function generateUniqueId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function parseInitData(initDataRaw) {
  if (!initDataRaw) return null;
  try {
    const parsed = querystring.parse(initDataRaw);
    if (!parsed.user) return null;
    const userObj = JSON.parse(parsed.user);
    return {
      telegram_id: String(userObj.id),
      username: userObj.username || ('user_' + userObj.id),
      first_name: userObj.first_name || 'Игрок',
      photo_url: userObj.photo_url || null,
      start_param: parsed.start_param || null
    };
  } catch (e) {
    return null;
  }
}

async function dbGetOrCreateUser(userData) {
  if (!userData || !userData.telegram_id) return null;
  const cleanId = String(userData.telegram_id).trim();

  try {
    let { data, error } = await supabase.from('users').select('*').eq('telegram_id', cleanId).maybeSingle();

    if (!data) {
      // Новый пользователь: гарантированно генерируем unique_id
      const newUser = {
        telegram_id: cleanId,
        unique_id: generateUniqueId(),
        username: userData.username || 'Игрок',
        first_name: userData.first_name || 'Игрок',
        photo_url: userData.photo_url || null,
        stars_balance: 50,
        wins: 0,
        losses: 0,
        level: 1,
        last_daily_claim: null
      };

      const { data: inserted, error: insertErr } = await supabase.from('users').insert([newUser]).select().single();
      if (insertErr) throw insertErr;

      if (userData.start_param) {
        processReferral(inserted.telegram_id, userData.start_param);
      }

      return inserted;
    }

    // Если у текущей записи в БД по какой-то причине нет unique_id — генерируем его и сохраняем
    const updatePayload = {};
    if (!data.unique_id || String(data.unique_id).trim() === '') {
      data.unique_id = generateUniqueId();
      updatePayload.unique_id = data.unique_id;
    }

    if (userData.photo_url && data.photo_url !== userData.photo_url) {
      updatePayload.photo_url = userData.photo_url;
      data.photo_url = userData.photo_url;
    }
    if (userData.first_name && data.first_name !== 'Игрок' && data.first_name !== userData.first_name) {
      updatePayload.first_name = userData.first_name;
      data.first_name = userData.first_name;
    }

    if (Object.keys(updatePayload).length > 0) {
      await supabase.from('users').update(updatePayload).eq('telegram_id', cleanId);
    }

    return data;
  } catch (err) {
    console.error(` Ошибка dbGetOrCreateUser (${cleanId}): ${err.message}`);
    return null;
  }
}

async function processReferral(newUserId, referrerUniqueId) {
  try {
    const { data: referrer } = await supabase.from('users').select('*').eq('unique_id', String(referrerUniqueId).trim()).maybeSingle();
    if (referrer && String(referrer.telegram_id) !== String(newUserId)) {
      const bonusBalance = Number(referrer.stars_balance || 0) + 10;
      await supabase.from('users').update({ stars_balance: bonusBalance }).eq('telegram_id', referrer.telegram_id);
    }
  } catch (e) {
    console.error('Ошибка реферала:', e.message);
  }
}

async function dbUpdateUser(telegramId, updateFields) {
  const cleanId = String(telegramId).trim();
  try {
    const { data, error } = await supabase.from('users').update(updateFields).eq('telegram_id', cleanId).select().maybeSingle();
    if (error) throw error;
    return data;
  } catch (err) {
    console.error(`Ошибка обновления ${cleanId}: ${err.message}`);
    return null;
  }
}

// Лидерборд: Сортировка строго ПО БАЛАНСУ ЗВЁЗД (stars_balance)
async function dbGetLeaderboard() {
  try {
    const { data, error } = await supabase.from('users')
      .select('telegram_id, unique_id, username, first_name, photo_url, stars_balance, wins, losses, level')
      .order('stars_balance', { ascending: false })
      .limit(50);

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Ошибка лидерборда:', err.message);
    return [];
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
    let userData = null;

    if (data?.initData) {
      userData = parseInitData(data.initData);
    }
    if (!userData && data?.telegram_id) {
      userData = {
        telegram_id: String(data.telegram_id),
        username: data.username || 'DevUser',
        first_name: data.first_name || 'Игрок',
        photo_url: data.photo_url || null
      };
    }

    if (!userData || !userData.telegram_id) return;

    socket._telegram_id = userData.telegram_id;
    currentUser = await dbGetOrCreateUser(userData);

    if (currentUser) {
      socket.emit('auth_success', currentUser);
      emitLobbies();
    }
  });

  socket.on('get_lobbies', () => { emitLobbies(socket); });

  socket.on('get_leaderboard', async () => {
    const list = await dbGetLeaderboard();
    socket.emit('leaderboard_data', list);
  });

  socket.on('claim_daily', async () => {
    if (!socket._telegram_id) return socket.emit('daily_error', { message: 'Ошибка авторизации!' });

    let user = await dbGetOrCreateUser({ telegram_id: socket._telegram_id });
    if (!user) return socket.emit('daily_error', { message: 'Профиль не найден' });

    const now = Math.floor(Date.now());
    const COOLDOWN = 24 * 60 * 60 * 1000;
    
    if (user.last_daily_claim && (now - Number(user.last_daily_claim) < COOLDOWN)) {
      const leftHours = Math.ceil((COOLDOWN - (now - Number(user.last_daily_claim))) / (1000 * 60 * 60));
      return socket.emit('daily_error', { message: `Бонус уже получен! Приходите через ${leftHours} ч.` });
    }

    const newBalance = Number(user.stars_balance || 0) + 10;
    const updatedUser = await dbUpdateUser(socket._telegram_id, { 
      stars_balance: newBalance, 
      last_daily_claim: now 
    });

    if (updatedUser) {
      currentUser = updatedUser;
      socket.emit('daily_success');
      socket.emit('auth_success', updatedUser);
    } else {
      user.stars_balance = newBalance;
      user.last_daily_claim = now;
      socket.emit('daily_success');
      socket.emit('auth_success', user);
    }
  });

  socket.on('get_friends', async () => {
    const tId = socket._telegram_id;
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
    const { uniqueId } = data || {};
    if (!socket._telegram_id || !uniqueId) return;

    try {
      const { data: targetUser } = await supabase.from('users').select('*').eq('unique_id', String(uniqueId).trim()).maybeSingle();
      if (!targetUser) {
        socket.emit('error_message', 'Игрок с таким ID не найден!');
        return;
      }

      if (String(targetUser.telegram_id) === String(socket._telegram_id)) {
        socket.emit('error_message', 'Нельзя отправить заявку самому себе!');
        return;
      }

      await supabase.from('friend_requests').upsert([
        { sender_id: socket._telegram_id, receiver_id: targetUser.telegram_id, status: 'pending' }
      ], { onConflict: ['sender_id', 'receiver_id'] });

      socket.emit('error_message', `Заявка отправлена игроку ${targetUser.first_name || targetUser.username}!`);
    } catch (e) {
      socket.emit('error_message', 'Ошибка отправки заявки.');
    }
  });

  socket.on('respond_friend_request', async (data) => {
    const { senderId, action } = data || {};
    if (!socket._telegram_id || !senderId) return;

    try {
      if (action === 'accept') {
        await supabase.from('friends').insert([
          { user_id: socket._telegram_id, friend_id: senderId },
          { user_id: senderId, friend_id: socket._telegram_id }
        ]);
      }
      await supabase.from('friend_requests').delete().eq('sender_id', senderId).eq('receiver_id', socket._telegram_id);

      socket.emit('error_message', action === 'accept' ? 'Заявка принята!' : 'Заявка отклонена.');
      socket.emit('get_friends');
    } catch (e) {
      socket.emit('error_message', 'Ошибка обработки заявки.');
    }
  });

  socket.on('leave_waiting_table', async (tableId) => {
    const table = tables.get(tableId);
    if (table && String(table.hostId) === String(socket._telegram_id)) {
      tables.delete(tableId);
      socket.leave(tableId);
      socket.emit('table_deleted');
      socket.emit('error_message', 'Вы вышли из стола!');
      emitLobbies();
    }
  });

  socket.on('create_table', async (config) => {
    if (!currentUser) return;

    for (let [tId, t] of tables.entries()) {
      if (String(t.hostId) === String(currentUser.telegram_id)) {
        socket.emit('table_created', tId);
        return;
      }
    }

    const { mode, deckSize, stake } = config || {};
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
      hostPhoto: currentUser.photo_url || null,
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
      socket.emit('error_message', 'Стол не найден!');
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

    const hostUser = await dbGetOrCreateUser({ telegram_id: table.hostId });
    if (!hostUser || (hostUser.stars_balance || 0) < table.stake) {
      socket.emit('error_message', 'У создателя стола недостаточно звезд!');
      return;
    }

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
        { id: String(hostUser.telegram_id), name: hostUser.first_name || hostUser.username, photoUrl: hostUser.photo_url, level: hostUser.level || 1, hand: p1Hand, socketId: null },
        { id: String(currentUser.telegram_id), name: currentUser.first_name || currentUser.username, photoUrl: currentUser.photo_url, level: currentUser.level || 1, hand: p2Hand, socketId: socket.id }
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
        players: game.players.map(p => ({ name: p.name, photoUrl: p.photoUrl, handCount: p.hand.length }))
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

    const totalPot = game.stake * 2;
    const prize = Math.round(totalPot * 0.9);

    const wUser = await dbGetOrCreateUser({ telegram_id: winner.id });
    const lUser = await dbGetOrCreateUser({ telegram_id: loser.id });

    wUser.stars_balance = (wUser.stars_balance || 0) + prize;
    wUser.wins = (wUser.wins || 0) + 1;
    lUser.losses = (lUser.losses || 0) + 1;

    await dbUpdateUser(wUser.telegram_id, { stars_balance: wUser.stars_balance, wins: wUser.wins });
    await dbUpdateUser(lUser.telegram_id, { losses: lUser.losses });

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
  const { gameId, action, cardId } = data || {};
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
