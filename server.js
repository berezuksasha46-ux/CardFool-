const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const users = {};           
const uniqueIdToTgId = {};  
const lobbies = {};         
const activeGames = {};     
const friendRequests = {}; 

const wheelMultipliers = [3, 0.5, 1.5, 0, 2, 0.5, 1.2, 0];
let wheelTimer = 7;
let wheelIsSpinning = false;
let wheelBets = [];

setInterval(() => {
  if (!wheelIsSpinning) {
    wheelTimer--;
    if (wheelTimer <= 0) {
      wheelIsSpinning = true;
      wheelTimer = 5;

      const winningIndex = Math.floor(Math.random() * 8);
      const targetMultiplier = wheelMultipliers[winningIndex];
      const targetDegree = (7 - winningIndex) * 45 + 22.5;

      wheelBets.forEach((bet) => {
        const player = users[bet.telegram_id];
        if (!player) return;
        const winAmount = Math.floor(bet.amount * targetMultiplier);
        player.stars_balance += winAmount;

        io.sockets.sockets.forEach((s) => {
          if (s.userId === player.telegram_id) {
            s.emit('wheel_spin_result', { targetDegree, multiplier: targetMultiplier, winAmount, newBalance: player.stars_balance });
          }
        });
      });

      io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: true, bets: wheelBets, targetDegree });

      setTimeout(() => {
        wheelIsSpinning = false;
        wheelTimer = 7;
        wheelBets = []; 
        io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
      }, 5000);
    } else {
      io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
    }
  }
}, 1000);

function createDeck(size) {
  const suits = ['♠', '♣', '♥', '♦'];
  const allRanks = size === 24 ? ['9', '10', 'J', 'Q', 'K', 'A'] : ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  let idCounter = 1;
  suits.forEach(suit => allRanks.forEach(rank => deck.push({ id: 'c_' + (idCounter++), suit, rank })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
io.on('connection', (socket) => {
  socket.on('auth', (data) => {
    const { telegram_id, username, first_name, photo_url, refId } = data;
    if (!telegram_id) return;

    let user = users[telegram_id];
    if (!user) {
      const newUniqueId = Math.floor(100000 + Math.random() * 900000).toString();
      user = {
        telegram_id: String(telegram_id),
        username: username || 'Игрок',
        first_name: first_name || 'Игрок',
        photo_url: photo_url || '',
        stars_balance: 0, 
        wins: 0, losses: 0,
        unique_id: newUniqueId,
        referrer_id: null,
        referral_count: 0,
        referral_earned: 0,
        friends: [],
        activated_promos: [],
        last_daily: 0
      };
      users[telegram_id] = user;
      uniqueIdToTgId[newUniqueId] = telegram_id;

      if (refId && refId !== newUniqueId && refId !== String(telegram_id)) {
        const referrerTgId = uniqueIdToTgId[refId] || refId;
        const referrer = users[referrerTgId];
        if (referrer) {
          user.referrer_id = referrer.unique_id;
          referrer.stars_balance += 10;
          referrer.referral_count += 1;
          referrer.referral_earned += 10;
        }
      }
    } else {
      user.username = username || user.username;
      user.first_name = first_name || user.first_name;
      user.photo_url = photo_url || user.photo_url;
    }

    socket.userId = user.telegram_id;
    socket.emit('auth_success', user);
    socket.emit('lobbies_list', { tables: Object.values(lobbies) });
    socket.emit('friend_requests_update', friendRequests[user.telegram_id] || []);
  });

  socket.on('send_friend_request', (data) => {
    const sender = users[socket.userId];
    if (!sender) return;
    const targetTgId = uniqueIdToTgId[data.targetId];
    if (!targetTgId || targetTgId === sender.telegram_id) return socket.emit('error_message', 'Игрок не найден!');

    if (!friendRequests[targetTgId]) friendRequests[targetTgId] = [];
    const exists = friendRequests[targetTgId].some(r => r.fromTgId === sender.telegram_id);
    if (!exists) {
      friendRequests[targetTgId].push({ fromTgId: sender.telegram_id, fromName: sender.first_name, fromUniqueId: sender.unique_id });
      io.sockets.sockets.forEach(s => {
        if (s.userId === targetTgId) s.emit('friend_requests_update', friendRequests[targetTgId]);
      });
      socket.emit('error_message', 'Заявка отправлена!');
    }
  });

  socket.on('respond_friend_request', (data) => {
    const recipient = users[socket.userId];
    if (!recipient) return;
    const reqList = friendRequests[recipient.telegram_id] || [];
    const reqIdx = reqList.findIndex(r => r.fromTgId === data.fromTgId);
    if (reqIdx === -1) return;

    if (data.accept) {
      const sender = users[data.fromTgId];
      if (sender) {
        if (!recipient.friends.includes(sender.unique_id)) recipient.friends.push(sender.unique_id);
        if (!sender.friends.includes(recipient.unique_id)) sender.friends.push(recipient.unique_id);
      }
    }
    reqList.splice(reqIdx, 1);
    socket.emit('friend_requests_update', reqList);
    socket.emit('auth_success', recipient);
  });

  socket.on('get_friends', () => {
    if (!socket.userId) return;
    const user = users[socket.userId];
    if (!user) return;
    const friendsList = (user.friends || []).map(id => users[uniqueIdToTgId[id]]).filter(Boolean);
    socket.emit('friends_list', { friends: friendsList });
  });

  socket.on('activate_promo', (data) => {
    const user = users[socket.userId];
    if (!user) return;
    const code = (data?.code || '').trim().toUpperCase();

    if (user.activated_promos.includes(code)) return socket.emit('error_message', 'Вы уже активировали этот промокод!');

    let reward = 0;
    if (code === 'SUPERRICKY') reward = 50;
    else if (code === 'BETATEST') reward = 150;
    else return socket.emit('error_message', 'Неверный промокод!');

    user.activated_promos.push(code);
    user.stars_balance += reward;
    socket.emit('auth_success', user);
    socket.emit('error_message', `🎉 Промокод активирован! Начислено +${reward} ⭐`);
  });

  socket.on('wheel_place_bet', (data) => {
    if (wheelIsSpinning) return socket.emit('error_message', 'Раунд уже вращается!');
    const user = users[socket.userId];
    const amount = Number(data?.amount);
    if (!user || !amount || amount <= 0 || user.stars_balance < amount) return socket.emit('error_message', 'Недостаточно средств!');

    user.stars_balance -= amount;
    const existing = wheelBets.find(b => b.telegram_id === user.telegram_id);
    if (existing) existing.amount += amount;
    else wheelBets.push({ telegram_id: user.telegram_id, name: user.first_name, amount });

    if (user.referrer_id) {
      const refUser = users[uniqueIdToTgId[user.referrer_id]];
      if (refUser) {
        const comm = Math.round(amount * 0.05);
        if (comm > 0) { refUser.stars_balance += comm; refUser.referral_earned += comm; }
      }
    }

    socket.emit('wheel_bet_accepted', { newBalance: user.stars_balance });
    io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
  });

  socket.on('get_lobbies', () => { socket.emit('lobbies_list', { tables: Object.values(lobbies) }); });

  socket.on('create_table', (data) => {
    const user = users[socket.userId];
    const stake = Number(data.stake) || 10;
    if (!user || user.stars_balance < stake) return socket.emit('error_message', 'Недостаточно звезд!');

    Object.keys(lobbies).forEach(id => { if (lobbies[id].hostId === user.telegram_id) delete lobbies[id]; });

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    lobbies[tableId] = {
      id: tableId, hostId: user.telegram_id, hostName: user.first_name,
      mode: data.mode || 'podkidnoy', deckSize: data.deckSize || 36, stake
    };
    socket.emit('table_created', tableId);
    io.emit('lobbies_list', { tables: Object.values(lobbies) });
  });

  socket.on('leave_waiting_table', (tableId) => {
    if (lobbies[tableId]) {
      delete lobbies[tableId];
      socket.emit('table_deleted');
      io.emit('lobbies_list', { tables: Object.values(lobbies) });
    }
  });

  socket.on('join_table', (tableId) => {
    const table = lobbies[tableId];
    const guest = users[socket.userId];
    if (!table || !guest || guest.stars_balance < table.stake) return socket.emit('error_message', 'Недостаточно средств!');

    const host = users[table.hostId];
    if (!host) return;

    // Списание ставок строго при старте игры
    host.stars_balance -= table.stake;
    guest.stars_balance -= table.stake;
    delete lobbies[tableId];
    io.emit('lobbies_list', { tables: Object.values(lobbies) });

    // Обновляем баланс в UI обоих игроков
    io.sockets.sockets.forEach(s => {
      if (s.userId === host.telegram_id) s.emit('auth_success', host);
      if (s.userId === guest.telegram_id) s.emit('auth_success', guest);
    });

    const gameId = 'game_' + Math.random().toString(36).substring(2, 9);
    const deck = createDeck(table.deckSize);
    activeGames[gameId] = {
      id: gameId, stake: table.stake, mode: table.mode, deck, trumpCard: deck[deck.length - 1], tableCards: [],
      players: [
        { id: host.telegram_id, name: host.first_name, photo_url: host.photo_url, hand: deck.splice(0, 6) },
        { id: guest.telegram_id, name: guest.first_name, photo_url: guest.photo_url, hand: deck.splice(0, 6) }
      ],
      attackerIdx: 0, defenderIdx: 1
    };
    broadcastGameState(gameId);
  });

  socket.on('game_action', (data) => {
    const game = activeGames[data.gameId];
    if (!game) return;
    const pIdx = game.players.findIndex(p => p.id === socket.userId);
    if (pIdx === -1) return;

    const isAttacker = (pIdx === game.attackerIdx);
    const isDefender = (pIdx === game.defenderIdx);

    if (data.action === 'play_card') {
      const hand = game.players[pIdx].hand;
      const cardIdx = hand.findIndex(c => c.id === data.cardId);
      if (cardIdx === -1) return;
      const card = hand[cardIdx];

      if (isAttacker) {
        if (game.tableCards.length > 0) {
          const valid = game.tableCards.some(pair => pair.attack.rank === card.rank || (pair.defend && pair.defend.rank === card.rank));
          if (!valid) return;
        }
        hand.splice(cardIdx, 1);
        game.tableCards.push({ attack: card, defend: null });
        broadcastGameState(data.gameId);
      } else if (isDefender) {
        const canTransfer = game.mode === 'perevodnoy' && game.tableCards.length > 0 && game.tableCards.every(pair => pair.defend === null) && game.tableCards[0].attack.rank === card.rank;
        if (canTransfer) {
          hand.splice(cardIdx, 1);
          game.tableCards.push({ attack: card, defend: null });
          game.defenderIdx = game.attackerIdx;
          game.attackerIdx = pIdx;
          broadcastGameState(data.gameId);
          return;
        }

        const openPair = game.tableCards.find(p => p.defend === null);
        if (!openPair) return;
        const attCard = openPair.attack;
        const isTrump = card.suit === game.trumpCard.suit;
        const isAttTrump = attCard.suit === game.trumpCard.suit;
        const rankOrder = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
        const canBeat = (isTrump && !isAttTrump) || (card.suit === attCard.suit && rankOrder[card.rank] > rankOrder[attCard.rank]);

        if (!canBeat) return;
        hand.splice(cardIdx, 1);
        openPair.defend = card;
        broadcastGameState(data.gameId);
      }
    } else if (data.action === 'bito' && isAttacker) {
      game.tableCards = [];
      refillHands(game);
      game.attackerIdx = game.defenderIdx;
      game.defenderIdx = (game.attackerIdx === 0 ? 1 : 0);
      broadcastGameState(data.gameId);
      checkGameOver(data.gameId);
    } else if (data.action === 'take' && isDefender) {
      const defHand = game.players[game.defenderIdx].hand;
      game.tableCards.forEach(pair => { defHand.push(pair.attack); if (pair.defend) defHand.push(pair.defend); });
      game.tableCards = [];
      refillHands(game);
      broadcastGameState(data.gameId);
      checkGameOver(data.gameId);
    }
  });

  socket.on('claim_daily', () => {
    const user = users[socket.userId];
    if (!user) return;
    const now = Date.now();
    if (user.last_daily && now - user.last_daily < 86400000) {
      const hoursLeft = Math.ceil((86400000 - (now - user.last_daily)) / 3600000);
      return socket.emit('error_message', `⏰ Бонус будет доступен через ${hoursLeft} ч.`);
    }
    user.last_daily = now;
    user.stars_balance += 10;
    socket.emit('auth_success', user);
    socket.emit('error_message', '🎁 Бонус получен (+10 ⭐)!');
  });

  socket.on('get_leaderboard', () => {
    socket.emit('leaderboard_data', Object.values(users).sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, 20));
  });
});

function refillHands(game) {
  [game.attackerIdx, game.defenderIdx].forEach(idx => {
    while (game.players[idx].hand.length < 6 && game.deck.length > 0) game.players[idx].hand.push(game.deck.pop());
  });
}

function broadcastGameState(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  io.sockets.sockets.forEach((s) => {
    const pIdx = game.players.findIndex(p => p.id === s.userId);
    if (pIdx === -1) return;
    s.emit('game_state', { 
      gameId: game.id, 
      deckCount: game.deck.length, 
      trumpCard: game.trumpCard, 
      tableCards: game.tableCards, 
      players: game.players.map(p => ({ id: p.id, name: p.name, photo_url: p.photo_url, handCount: p.hand.length })) 
    });
    s.emit('your_hand', game.players[pIdx].hand);
    s.emit('is_turn_data', { isMyTurn: (pIdx === game.attackerIdx || pIdx === game.defenderIdx), isAttacker: (pIdx === game.attackerIdx) });
  });
}

function checkGameOver(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  if (game.deck.length === 0) {
    const p0Empty = game.players[0].hand.length === 0;
    const p1Empty = game.players[1].hand.length === 0;
    if (p0Empty || p1Empty) {
      const winnerIdx = p0Empty ? 0 : 1;
      const loserIdx = p0Empty ? 1 : 0;

      const totalBank = game.stake * 2;
      const prize = Math.floor(totalBank * 0.9); // 10% системная комиссия

      const winner = users[game.players[winnerIdx].id];
      const loser = users[game.players[loserIdx].id];

      if (winner) { winner.wins = (winner.wins || 0) + 1; winner.stars_balance += prize; }
      if (loser) { loser.losses = (loser.losses || 0) + 1; }

      io.sockets.sockets.forEach((s) => {
        if (s.userId === game.players[winnerIdx].id) {
          s.emit('game_over', { won: true, prize });
          s.emit('auth_success', winner);
        } else if (s.userId === game.players[loserIdx].id) {
          s.emit('game_over', { won: false, prize: 0 });
          s.emit('auth_success', loser);
        }
      });
      delete activeGames[gameId];
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CardFool Swiss Watch Server running on port ${PORT}`));
