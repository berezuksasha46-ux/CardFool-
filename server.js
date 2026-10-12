const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Раздача статики и отдавание index.html
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Хранилища в памяти
const users = {};           
const uniqueIdToTgId = {};  
const lobbies = {};         
const activeGames = {};     

// --- КОЛЕСО ФОРТУНЫ ---
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
      const multipliers = [0.5, 1.5, 0, 2, 0.5, 1.2, 0, 3];
      const targetMultiplier = multipliers[winningIndex];
      const targetDegree = winningIndex * 45 + 22.5;

      wheelBets.forEach((bet) => {
        const player = users[bet.telegram_id];
        if (!player) return;

        const winAmount = Math.floor(bet.amount * targetMultiplier);
        player.stars_balance += winAmount;

        io.sockets.sockets.forEach((s) => {
          if (s.userId === player.telegram_id) {
            s.emit('wheel_spin_result', {
              targetDegree,
              multiplier: targetMultiplier,
              winAmount,
              newBalance: player.stars_balance
            });
          }
        });
      });

      io.emit('wheel_state', {
        timeLeft: wheelTimer,
        isSpinning: true,
        bets: wheelBets
      });

      setTimeout(() => {
        wheelIsSpinning = false;
        wheelTimer = 7;
        wheelBets = []; 
        io.emit('wheel_state', {
          timeLeft: wheelTimer,
          isSpinning: false,
          bets: wheelBets
        });
      }, 5000);
    } else {
      io.emit('wheel_state', {
        timeLeft: wheelTimer,
        isSpinning: false,
        bets: wheelBets
      });
    }
  }
}, 1000);

// --- СОЗДАНИЕ КОЛОДЫ ---
function createDeck(size) {
  const suits = ['♠', '♣', '♥', '♦'];
  const allRanks = size === 24 ? ['9', '10', 'J', 'Q', 'K', 'A'] : ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  let idCounter = 1;

  suits.forEach(suit => {
    allRanks.forEach(rank => {
      deck.push({ id: 'c_' + (idCounter++), suit, rank });
    });
  });

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
io.on('connection', (socket) => {

  // 1. АВТОРИЗАЦИЯ
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
        stars_balance: 100,
        wins: 0,
        losses: 0,
        unique_id: newUniqueId,
        referrer_id: null,
        referral_count: 0,
        referral_earned: 0
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

          io.sockets.sockets.forEach((s) => {
            if (s.userId === referrer.telegram_id) {
              s.emit('auth_success', referrer);
              s.emit('error_message', `🎉 По вашей ссылке зарегистрировался ${user.first_name}! Вам начислено +10 ⭐`);
            }
          });
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
  });

  // 2. ДРУЗЬЯ И РЕФЕРАЛЫ
  socket.on('get_friends', () => {
    if (!socket.userId) return;
    const user = users[socket.userId];
    if (!user) return;

    const myReferrals = Object.values(users).filter(u => u.referrer_id === user.unique_id);

    socket.emit('friends_list', {
      friends: myReferrals,
      referralCount: user.referral_count,
      referralEarned: user.referral_earned
    });
  });

  // 3. СТАВКИ В КОЛЕСЕ
  socket.on('wheel_place_bet', (data) => {
    if (wheelIsSpinning) {
      return socket.emit('error_message', 'Раунд уже начался, дождитесь следующего!');
    }

    const user = users[socket.userId];
    const amount = Number(data?.amount);

    if (!user || !amount || amount <= 0) return socket.emit('error_message', 'Некорректная сумма!');
    if (user.stars_balance < amount) return socket.emit('error_message', 'Недостаточно звезд!');

    user.stars_balance -= amount;

    const existing = wheelBets.find(b => b.telegram_id === user.telegram_id);
    if (existing) {
      existing.amount += amount;
    } else {
      wheelBets.push({
        telegram_id: user.telegram_id,
        name: user.first_name || user.username || 'Игрок',
        amount: amount
      });
    }

    if (user.referrer_id) {
      const refTgId = uniqueIdToTgId[user.referrer_id];
      const referrer = users[refTgId];
      if (referrer) {
        const comm = Math.round(amount * 0.05);
        if (comm > 0) {
          referrer.stars_balance += comm;
          referrer.referral_earned += comm;
        }
      }
    }

    socket.emit('wheel_bet_accepted', { newBalance: user.stars_balance });
    io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
  });

  // 4. СТОЛЫ ДЛЯ ДУРАКА
  socket.on('get_lobbies', () => {
    socket.emit('lobbies_list', { tables: Object.values(lobbies) });
  });

  socket.on('create_table', (data) => {
    const user = users[socket.userId];
    if (!user) return;
    if (user.stars_balance < data.stake) return socket.emit('error_message', 'Недостаточно звезд!');

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    lobbies[tableId] = {
      id: tableId,
      hostId: user.telegram_id,
      hostName: user.first_name || user.username,
      mode: data.mode || 'podkidnoy',
      deckSize: data.deckSize || 36,
      stake: data.stake || 10
    };

    socket.emit('table_created', tableId);
    io.emit('lobbies_list', { tables: Object.values(lobbies) });
  });

  socket.on('leave_waiting_table', (tableId) => {
    if (lobbies[tableId] && lobbies[tableId].hostId === socket.userId) {
      delete lobbies[tableId];
      socket.emit('table_deleted');
      io.emit('lobbies_list', { tables: Object.values(lobbies) });
    }
  });

  socket.on('join_table', (tableId) => {
    const table = lobbies[tableId];
    const guest = users[socket.userId];
    if (!table || !guest) return;
    if (guest.stars_balance < table.stake) return socket.emit('error_message', 'Недостаточно средств!');

    const host = users[table.hostId];
    if (!host) return;

    host.stars_balance -= table.stake;
    guest.stars_balance -= table.stake;

    delete lobbies[tableId];
    io.emit('lobbies_list', { tables: Object.values(lobbies) });

    const gameId = 'game_' + Math.random().toString(36).substring(2, 9);
    const deck = createDeck(table.deckSize);
    const trumpCard = deck[deck.length - 1];

    const hostHand = deck.splice(0, 6);
    const guestHand = deck.splice(0, 6);

    activeGames[gameId] = {
      id: gameId,
      stake: table.stake,
      deck,
      trumpCard,
      tableCards: [],
      players: [
        { id: host.telegram_id, name: host.first_name, photoUrl: host.photo_url, hand: hostHand },
        { id: guest.telegram_id, name: guest.first_name, photoUrl: guest.photo_url, hand: guestHand }
      ],
      attackerIdx: 0,
      defenderIdx: 1,
      isTaking: false
    };

    broadcastGameState(gameId);
  });
  // 5. ИГРОВЫЕ ДЕЙСТВИЯ (ДУРАК)
  socket.on('game_action', (data) => {
    const { gameId, action, cardId } = data;
    const game = activeGames[gameId];
    if (!game) return;

    const pIdx = game.players.findIndex(p => p.id === socket.userId);
    if (pIdx === -1) return;

    const isAttacker = (pIdx === game.attackerIdx);
    const isDefender = (pIdx === game.defenderIdx);

    if (action === 'play_card') {
      const hand = game.players[pIdx].hand;
      const cardIdx = hand.findIndex(c => c.id === cardId);
      if (cardIdx === -1) return;
      const card = hand[cardIdx];

      if (isAttacker) {
        if (game.tableCards.length > 0) {
          const valid = game.tableCards.some(pair => pair.attack.rank === card.rank || (pair.defend && pair.defend.rank === card.rank));
          if (!valid) return;
        }
        hand.splice(cardIdx, 1);
        game.tableCards.push({ attack: card, defend: null });
        broadcastGameState(gameId);
      } else if (isDefender) {
        const openPair = game.tableCards.find(p => p.defend === null);
        if (!openPair) return;

        const attCard = openPair.attack;
        const isTrumpCard = card.suit === game.trumpCard.suit;
        const isAttTrump = attCard.suit === game.trumpCard.suit;

        const rankOrder = { '6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
        const canBeat = (isTrumpCard && !isAttTrump) || (card.suit === attCard.suit && rankOrder[card.rank] > rankOrder[attCard.rank]);

        if (!canBeat) return;

        hand.splice(cardIdx, 1);
        openPair.defend = card;
        broadcastGameState(gameId);
      }
    } else if (action === 'bito' && isAttacker) {
      game.tableCards = [];
      refillHands(game);
      game.attackerIdx = game.defenderIdx;
      game.defenderIdx = (game.attackerIdx === 0 ? 1 : 0);
      broadcastGameState(gameId);
      checkGameOver(gameId);
    } else if (action === 'take' && isDefender) {
      const defenderHand = game.players[game.defenderIdx].hand;
      game.tableCards.forEach(pair => {
        defenderHand.push(pair.attack);
        if (pair.defend) defenderHand.push(pair.defend);
      });
      game.tableCards = [];
      refillHands(game);
      broadcastGameState(gameId);
      checkGameOver(gameId);
    }
  });

  socket.on('claim_daily', () => {
    const user = users[socket.userId];
    if (!user) return;
    user.stars_balance += 10;
    socket.emit('auth_success', user);
    socket.emit('daily_success');
  });

  socket.on('get_user_profile', (data) => {
    const target = users[uniqueIdToTgId[data.targetId] || data.targetId];
    if (target) socket.emit('user_profile_data', target);
  });

  socket.on('get_leaderboard', () => {
    const sorted = Object.values(users).sort((a, b) => (b.wins || 0) - (a.wins || 0)).slice(0, 20);
    socket.emit('leaderboard_data', sorted);
  });
});

function refillHands(game) {
  [game.attackerIdx, game.defenderIdx].forEach(idx => {
    while (game.players[idx].hand.length < 6 && game.deck.length > 0) {
      game.players[idx].hand.push(game.deck.pop());
    }
  });
}

function broadcastGameState(gameId) {
  const game = activeGames[gameId];
  if (!game) return;

  io.sockets.sockets.forEach((s) => {
    const pIdx = game.players.findIndex(p => p.id === s.userId);
    if (pIdx === -1) return;

    const p = game.players[pIdx];
    const opponent = game.players[pIdx === 0 ? 1 : 0];

    s.emit('game_state', {
      gameId: game.id,
      deckCount: game.deck.length,
      trumpCard: game.trumpCard,
      tableCards: game.tableCards,
      isTakingState: game.isTaking,
      players: [
        { id: p.id, name: p.name, photoUrl: p.photoUrl, handCount: p.hand.length },
        { id: opponent.id, name: opponent.name, photoUrl: opponent.photoUrl, handCount: opponent.hand.length }
      ]
    });

    s.emit('your_hand', p.hand);
    s.emit('is_turn_data', {
      isMyTurn: true,
      isAttacker: (pIdx === game.attackerIdx)
    });
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
      const prize = game.stake * 2;

      const winner = users[game.players[winnerIdx].id];
      const loser = users[game.players[loserIdx].id];

      if (winner) { winner.wins = (winner.wins || 0) + 1; winner.stars_balance += prize; }
      if (loser) { loser.losses = (loser.losses || 0) + 1; }

      io.sockets.sockets.forEach((s) => {
        if (s.userId === game.players[winnerIdx].id) {
          s.emit('game_over', { won: true, prize });
        } else if (s.userId === game.players[loserIdx].id) {
          s.emit('game_over', { won: false, prize: 0 });
        }
      });

      delete activeGames[gameId];
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CardFool VIP Server running on port ${PORT}`));
