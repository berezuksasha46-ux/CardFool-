const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const admin = require('firebase-admin');

let serviceAccount;
try {
  if (process.env.FIREBASE_KEY) {
    let rawKey = process.env.FIREBASE_KEY.trim();
    if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
      rawKey = rawKey.slice(1, -1);
    }
    serviceAccount = JSON.parse(rawKey);
    
    // Преобразуем \\n в настоящие переносы строк
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
  } else {
    serviceAccount = require('./firebase-key.json');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Успешное подключение к Firebase Firestore!');
} catch (e) {
  console.error('❌ Ошибка инициализации Firebase:', e.message);
}

const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const onlineUsers = new Set();
const lobbies = {};         
const activeGames = {};     
const friendRequests = {}; 
async function initDefaultQuests() {
  const qRef = db.collection('quests');
  const snapshot = await qRef.get();
  if (snapshot.empty) {
    await qRef.doc('q_1').set({ id: 'q_1', title: 'Сыграть 3 партии в Дурака', target: 3, reward: 15, type: 'play' });
    await qRef.doc('q_2').set({ id: 'q_2', title: 'Выиграть 1 игру', target: 1, reward: 20, type: 'win' });
    console.log('📌 Дефолтные квесты созданы в Firestore.');
  }
}
initDefaultQuests();

setInterval(async () => {
  const now = new Date();
  if (now.getDay() === 0 && now.getHours() === 23 && now.getMinutes() === 59) {
    const usersSnapshot = await db.collection('users').where('weekly_refs', '>', 0).orderBy('weekly_refs', 'desc').get();
    const usersList = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (usersList[0]) {
      const uRef = db.collection('users').doc(usersList[0].id);
      await uRef.update({ stars_balance: (usersList[0].stars_balance || 0) + 50 });
    }
    if (usersList[1]) {
      const uRef = db.collection('users').doc(usersList[1].id);
      await uRef.update({ stars_balance: (usersList[1].stars_balance || 0) + 25 });
    }
    if (usersList[2]) {
      const uRef = db.collection('users').doc(usersList[2].id);
      await uRef.update({ stars_balance: (usersList[2].stars_balance || 0) + 10 });
    }

    const batch = db.batch();
    const allUsers = await db.collection('users').get();
    allUsers.forEach(doc => {
      batch.update(doc.ref, { weekly_refs: 0 });
    });
    await batch.commit();
  }
}, 60000);

const wheelMultipliers = [3, 0.5, 1.5, 0, 2, 0.5, 1.2, 0];
let wheelTimer = 7;
let wheelIsSpinning = false;
let wheelBets = [];

setInterval(async () => {
  if (!wheelIsSpinning) {
    wheelTimer--;
    if (wheelTimer <= 0) {
      wheelIsSpinning = true;
      wheelTimer = 5;

      const winningIndex = Math.floor(Math.random() * 8);
      const targetMultiplier = wheelMultipliers[winningIndex];
      const targetDegree = (7 - winningIndex) * 45 + 22.5;

      for (const bet of wheelBets) {
        const userRef = db.collection('users').doc(bet.telegram_id);
        const userDoc = await userRef.get();
        if (!userDoc.exists) continue;
        const userData = userDoc.data();

        const winAmount = Math.floor(bet.amount * targetMultiplier);
        const newBalance = (userData.stars_balance || 0) + winAmount;
        await userRef.update({ stars_balance: newBalance });

        io.sockets.sockets.forEach((s) => {
          if (s.userId === bet.telegram_id) {
            s.emit('wheel_spin_result', { targetDegree, multiplier: targetMultiplier, winAmount, newBalance });
          }
        });
      }

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

async function updateQuestProgress(telegramId, type) {
  const userRef = db.collection('users').doc(telegramId);
  const userDoc = await userRef.get();
  if (!userDoc.exists) return;
  const userData = userDoc.data();

  const questsSnapshot = await db.collection('quests').where('type', '==', type).get();
  let questProgress = userData.quest_progress || {};
  let claimedQuests = userData.claimed_quests || [];

  let updated = false;
  questsSnapshot.forEach(doc => {
    const q = doc.data();
    if (!claimedQuests.includes(q.id)) {
      const current = questProgress[q.id] || 0;
      if (current < q.target) {
        questProgress[q.id] = current + 1;
        updated = true;
      }
    }
  });

  if (updated) {
    await userRef.update({ quest_progress: questProgress });
  }
}
io.on('connection', (socket) => {
  socket.on('auth', async (data) => {
    const { telegram_id, username, first_name, photo_url, refId } = data;
    if (!telegram_id) return;

    const tgIdStr = String(telegram_id);
    const newUniqueId = tgIdStr.slice(0, 6);
    const userRef = db.collection('users').doc(tgIdStr);
    const userDoc = await userRef.get();

    let userData;
    if (!userDoc.exists) {
      userData = {
        telegram_id: tgIdStr,
        username: username || 'Игрок',
        first_name: first_name || 'Игрок',
        photo_url: photo_url || '',
        stars_balance: 0, 
        wins: 0, 
        losses: 0,
        unique_id: newUniqueId,
        referrer_id: null,
        referral_count: 0,
        weekly_refs: 0,
        friends: [],
        activated_promos: [],
        claimed_quests: [],
        quest_progress: {},
        last_daily: 0
      };
      await userRef.set(userData);

      if (refId && refId !== newUniqueId && refId !== tgIdStr) {
        const refQuery = await db.collection('users').where('unique_id', '==', refId).limit(1).get();
        if (!refQuery.empty) {
          const refDoc = refQuery.docs[0];
          const refData = refDoc.data();
          const refRef = refDoc.ref;

          userData.referrer_id = refData.unique_id;
          await userRef.update({ referrer_id: refData.unique_id });

          let newBal = (refData.stars_balance || 0) + 10;
          let newRefCnt = (refData.referral_count || 0) + 1;
          let newWeeklyRefs = (refData.weekly_refs || 0) + 1;

          if (newRefCnt === 3) newBal += 12;
          if (newRefCnt === 10) newBal += 25;
          if (newRefCnt === 25) newBal += 75;
          if (newRefCnt === 50) newBal += 250;

          await refRef.update({
            stars_balance: newBal,
            referral_count: newRefCnt,
            weekly_refs: newWeeklyRefs
          });
        }
      }
    } else {
      userData = userDoc.data();
      userData.unique_id = newUniqueId;
      userData.username = username || userData.username;
      userData.first_name = first_name || userData.first_name;
      userData.photo_url = photo_url || userData.photo_url;
      await userRef.update({
        unique_id: newUniqueId,
        username: userData.username,
        first_name: userData.first_name,
        photo_url: userData.photo_url
      });
    }

    socket.userId = tgIdStr;
    onlineUsers.add(tgIdStr);

    socket.emit('auth_success', userData);
    socket.emit('lobbies_list', { tables: Object.values(lobbies) });

    const tourSnapshot = await db.collection('tournaments').get();
    socket.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
    socket.emit('friend_requests_update', friendRequests[tgIdStr] || []);

    socket.on('disconnect', () => {
      if (socket.userId) onlineUsers.delete(socket.userId);
    });
  });

  socket.on('admin_create_tournament', async (data) => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const uData = userDoc.data();
    if (!uData.telegram_id.startsWith('186601') && uData.unique_id !== '186601') return;

    const prize = (data.prizeType === 'fixed') ? data.fixedPrize : Math.floor(data.stake * data.players * 0.9);
    const tourId = 'tour_' + Date.now();
    const tourObj = {
      id: tourId,
      title: data.title,
      maxPlayers: data.players,
      mode: data.mode,
      deckSize: data.deckSize,
      stake: data.stake,
      prize,
      joined: [],
      joinedCount: 0
    };

    await db.collection('tournaments').doc(tourId).set(tourObj);
    const tourSnapshot = await db.collection('tournaments').get();
    io.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
  });

  socket.on('admin_create_quest', async (data) => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const uData = userDoc.data();
    if (!uData.telegram_id.startsWith('186601') && uData.unique_id !== '186601') return;

    const qId = 'q_' + Date.now();
    await db.collection('quests').doc(qId).set({
      id: qId,
      title: data.title,
      target: data.target,
      reward: data.reward,
      type: 'play'
    });

    const questsSnap = await db.collection('quests').get();
    io.emit('daily_quests_data', questsSnap.docs.map(doc => ({ ...doc.data(), progress: 0, claimed: false })));
  });
  socket.on('get_daily_quests', async () => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const questsSnap = await db.collection('quests').get();
    const questProgress = userData.quest_progress || {};
    const claimedQuests = userData.claimed_quests || [];

    const questsData = questsSnap.docs.map(doc => {
      const q = doc.data();
      return {
        ...q,
        progress: questProgress[q.id] || 0,
        claimed: claimedQuests.includes(q.id)
      };
    });
    socket.emit('daily_quests_data', questsData);
  });

  socket.on('claim_quest', async (questId) => {
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    const questDoc = await db.collection('quests').doc(questId).get();
    if (!userDoc.exists || !questDoc.exists) return;

    const userData = userDoc.data();
    const qData = questDoc.data();
    let claimedQuests = userData.claimed_quests || [];

    if (claimedQuests.includes(questId)) return socket.emit('error_message', 'Награда уже получена!');

    const questProgress = userData.quest_progress || {};
    const currentProgress = questProgress[questId] || 0;

    if (currentProgress < qData.target) {
      return socket.emit('error_message', `Задание еще не выполнено! (${currentProgress}/${qData.target})`);
    }

    claimedQuests.push(questId);
    const newBalance = (userData.stars_balance || 0) + qData.reward;

    await userRef.update({
      claimed_quests: claimedQuests,
      stars_balance: newBalance
    });

    const updatedUserDoc = await userRef.get();
    socket.emit('auth_success', updatedUserDoc.data());
    socket.emit('error_message', `🎉 Задание выполнено! Начислено +${qData.reward} ⭐`);

    const questsSnap = await db.collection('quests').get();
    const updatedQuestsData = questsSnap.docs.map(doc => {
      const q = doc.data();
      return {
        ...q,
        progress: (updatedUserDoc.data().quest_progress || {})[q.id] || 0,
        claimed: updatedUserDoc.data().claimed_quests.includes(q.id)
      };
    });
    socket.emit('daily_quests_data', updatedQuestsData);
  });

  socket.on('get_tournaments', async () => {
    const tourSnapshot = await db.collection('tournaments').get();
    socket.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
  });

  socket.on('join_tournament', async (tourId) => {
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    const tourRef = db.collection('tournaments').doc(tourId);
    const tourDoc = await tourRef.get();

    if (!userDoc.exists || !tourDoc.exists) return;
    const userData = userDoc.data();
    const tourData = tourDoc.data();

    if (tourData.joined.includes(userData.telegram_id)) return socket.emit('error_message', 'Вы уже зарегистрированы!');
    if (tourData.joinedCount >= tourData.maxPlayers) return socket.emit('error_message', 'Турнир полон!');
    if ((userData.stars_balance || 0) < tourData.stake) return socket.emit('error_message', 'Недостаточно звезд!');

    const newBal = userData.stars_balance - tourData.stake;
    await userRef.update({ stars_balance: newBal });

    tourData.joined.push(userData.telegram_id);
    tourData.joinedCount++;
    await tourRef.update({ joined: tourData.joined, joinedCount: tourData.joinedCount });

    const freshUserDoc = await userRef.get();
    socket.emit('auth_success', freshUserDoc.data());
    
    const tourSnapshot = await db.collection('tournaments').get();
    io.emit('tournaments_data', tourSnapshot.docs.map(doc => doc.data()));
    socket.emit('error_message', 'Вы успешно вступили в турнир!');
  });

  socket.on('get_user_profile', async (data) => {
    const query = await db.collection('users').where('unique_id', '==', data.targetId).limit(1).get();
    if (!query.empty) {
      const targetUser = query.docs[0].data();
      socket.emit('user_profile_data', {
        first_name: targetUser.first_name,
        unique_id: targetUser.unique_id,
        photo_url: targetUser.photo_url,
        wins: targetUser.wins || 0,
        losses: targetUser.losses || 0,
        referral_count: targetUser.referral_count || 0,
        stars_balance: targetUser.stars_balance || 0,
        is_online: onlineUsers.has(targetUser.telegram_id)
      });
    }
  });

  socket.on('send_friend_request', async (data) => {
    const senderDoc = await db.collection('users').doc(socket.userId).get();
    if (!senderDoc.exists) return;
    const senderData = senderDoc.data();

    const targetQuery = await db.collection('users').where('unique_id', '==', data.targetId).limit(1).get();
    if (targetQuery.empty) return socket.emit('error_message', 'Игрок не найден!');

    const targetDoc = targetQuery.docs[0];
    const targetData = targetDoc.data();
    const targetTgId = targetData.telegram_id;

    if (targetTgId === senderData.telegram_id) return socket.emit('error_message', 'Нельзя добавить себя!');

    if (!friendRequests[targetTgId]) friendRequests[targetTgId] = [];
    const exists = friendRequests[targetTgId].some(r => r.fromTgId === senderData.telegram_id);
    if (!exists) {
      friendRequests[targetTgId].push({ fromTgId: senderData.telegram_id, fromName: senderData.first_name, fromUniqueId: senderData.unique_id });
      io.sockets.sockets.forEach(s => {
        if (s.userId === targetTgId) s.emit('friend_requests_update', friendRequests[targetTgId]);
      });
      socket.emit('error_message', 'Заявка отправлена!');
    }
  });
  socket.on('respond_friend_request', async (data) => {
    const recipientRef = db.collection('users').doc(socket.userId);
    const recipientDoc = await recipientRef.get();
    if (!recipientDoc.exists) return;
    const recipientData = recipientDoc.data();

    const reqList = friendRequests[recipientData.telegram_id] || [];
    const reqIdx = reqList.findIndex(r => r.fromTgId === data.fromTgId);
    if (reqIdx === -1) return;

    if (data.accept) {
      const senderRef = db.collection('users').doc(data.fromTgId);
      const senderDoc = await senderRef.get();
      if (senderDoc.exists) {
        const senderData = senderDoc.data();

        let recipientFriends = recipientData.friends || [];
        let senderFriends = senderData.friends || [];

        if (!recipientFriends.includes(senderData.unique_id)) recipientFriends.push(senderData.unique_id);
        if (!senderFriends.includes(recipientData.unique_id)) senderFriends.push(recipientData.unique_id);

        await recipientRef.update({ friends: recipientFriends });
        await senderRef.update({ friends: senderFriends });
      }
    }
    reqList.splice(reqIdx, 1);
    socket.emit('friend_requests_update', reqList);
    
    const freshDoc = await recipientRef.get();
    socket.emit('auth_success', freshDoc.data());
  });

  socket.on('get_friends', async () => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const friendsList = [];
    for (const id of (userData.friends || [])) {
      const fQuery = await db.collection('users').where('unique_id', '==', id).limit(1).get();
      if (!fQuery.empty) {
        const fData = fQuery.docs[0].data();
        friendsList.push({
          ...fData,
          is_online: onlineUsers.has(fData.telegram_id)
        });
      }
    }
    socket.emit('friends_list', { friends: friendsList });
  });

  socket.on('activate_promo', async (data) => {
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const code = (data?.code || '').trim().toUpperCase();
    let activated = userData.activated_promos || [];
    if (activated.includes(code)) return socket.emit('error_message', 'Вы уже активировали этот промокод!');

    let reward = 0;
    if (code === 'SUPERRICKY') reward = 50;
    else if (code === 'BETATEST') reward = 150;
    else return socket.emit('error_message', 'Неверный промокод!');

    activated.push(code);
    const newBal = (userData.stars_balance || 0) + reward;
    await userRef.update({ activated_promos: activated, stars_balance: newBal });

    const freshDoc = await userRef.get();
    socket.emit('auth_success', freshDoc.data());
    socket.emit('error_message', `🎉 Промокод активирован! Начислено +${reward} ⭐`);
  });

  socket.on('wheel_place_bet', async (data) => {
    if (wheelIsSpinning) return socket.emit('error_message', 'Раунд уже вращается!');
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const amount = Number(data?.amount);
    if (!amount || amount <= 0 || (userData.stars_balance || 0) < amount) return socket.emit('error_message', 'Недостаточно средств!');

    const newBal = userData.stars_balance - amount;
    await userRef.update({ stars_balance: newBal });

    const existing = wheelBets.find(b => b.telegram_id === userData.telegram_id);
    if (existing) existing.amount += amount;
    else wheelBets.push({ telegram_id: userData.telegram_id, name: userData.first_name, amount });

    if (userData.referrer_id) {
      const refQuery = await db.collection('users').where('unique_id', '==', userData.referrer_id).limit(1).get();
      if (!refQuery.empty) {
        const refDoc = refQuery.docs[0];
        const refData = refDoc.data();
        const comm = Math.round(amount * 0.05);
        if (comm > 0) {
          await refDoc.ref.update({ stars_balance: (refData.stars_balance || 0) + comm });
        }
      }
    }

    socket.emit('wheel_bet_accepted', { newBalance: newBal });
    io.emit('wheel_state', { timeLeft: wheelTimer, isSpinning: false, bets: wheelBets });
  });

  socket.on('get_lobbies', () => { socket.emit('lobbies_list', { tables: Object.values(lobbies) }); });

  socket.on('create_table', async (data) => {
    const userDoc = await db.collection('users').doc(socket.userId).get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const stake = Number(data.stake) || 10;
    if ((userData.stars_balance || 0) < stake) return socket.emit('error_message', 'Недостаточно звезд!');

    Object.keys(lobbies).forEach(id => { if (lobbies[id].hostId === userData.telegram_id) delete lobbies[id]; });

    const tableId = 'table_' + Math.random().toString(36).substring(2, 9);
    lobbies[tableId] = {
      id: tableId, hostId: userData.telegram_id, hostName: userData.first_name,
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
  socket.on('join_table', async (tableId) => {
    const table = lobbies[tableId];
    const guestRef = db.collection('users').doc(socket.userId);
    const guestDoc = await guestRef.get();
    if (!table || !guestDoc.exists) return;
    const guestData = guestDoc.data();

    if ((guestData.stars_balance || 0) < table.stake) return socket.emit('error_message', 'Недостаточно средств!');

    const hostRef = db.collection('users').doc(table.hostId);
    const hostDoc = await hostRef.get();
    if (!hostDoc.exists) return;
    const hostData = hostDoc.data();

    await hostRef.update({ stars_balance: (hostData.stars_balance || 0) - table.stake });
    await guestRef.update({ stars_balance: (guestData.stars_balance || 0) - table.stake });

    delete lobbies[tableId];
    io.emit('lobbies_list', { tables: Object.values(lobbies) });

    const freshHost = await hostRef.get();
    const freshGuest = await guestRef.get();

    io.sockets.sockets.forEach(s => {
      if (s.userId === hostData.telegram_id) s.emit('auth_success', freshHost.data());
      if (s.userId === guestData.telegram_id) s.emit('auth_success', freshGuest.data());
    });

    const gameId = 'game_' + Math.random().toString(36).substring(2, 9);
    const deck = createDeck(table.deckSize);
    activeGames[gameId] = {
      id: gameId, stake: table.stake, mode: table.mode, deck, trumpCard: deck[deck.length - 1], tableCards: [],
      players: [
        { id: hostData.telegram_id, name: hostData.first_name, photo_url: hostData.photo_url, hand: deck.splice(0, 6) },
        { id: guestData.telegram_id, name: guestData.first_name, photo_url: guestData.photo_url, hand: deck.splice(0, 6) }
      ],
      attackerIdx: 0, defenderIdx: 1
    };

    await updateQuestProgress(hostData.telegram_id, 'play');
    await updateQuestProgress(guestData.telegram_id, 'play');

    broadcastGameState(gameId);
  });

  socket.on('game_action', async (data) => {
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

  socket.on('claim_daily', async () => {
    const userRef = db.collection('users').doc(socket.userId);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return;
    const userData = userDoc.data();

    const now = Date.now();
    if (userData.last_daily && now - userData.last_daily < 86400000) {
      const hoursLeft = Math.ceil((86400000 - (now - userData.last_daily)) / 3600000);
      return socket.emit('error_message', `⏰ Бонус будет доступен через ${hoursLeft} ч.`);
    }

    const newBal = (userData.stars_balance || 0) + 10;
    await userRef.update({ last_daily: now, stars_balance: newBal });

    const freshDoc = await userRef.get();
    socket.emit('auth_success', freshDoc.data());
    socket.emit('error_message', '🎁 Бонус получен (+10 ⭐)!');
  });

  socket.on('get_leaderboard', async () => {
    const topStarsSnap = await db.collection('users').orderBy('wins', 'desc').limit(20).get();
    const topStars = topStarsSnap.docs.map(doc => doc.data());

    const topRefsSnap = await db.collection('users').where('weekly_refs', '>', 0).orderBy('weekly_refs', 'desc').limit(20).get();
    const topRefs = topRefsSnap.docs.map(doc => doc.data());

    socket.emit('leaderboard_data', { topStars, topRefs });
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

async function checkGameOver(gameId) {
  const game = activeGames[gameId];
  if (!game) return;
  if (game.deck.length === 0) {
    const p0Empty = game.players[0].hand.length === 0;
    const p1Empty = game.players[1].hand.length === 0;
    if (p0Empty || p1Empty) {
      const winnerIdx = p0Empty ? 0 : 1;
      const loserIdx = p0Empty ? 1 : 0;

      const totalBank = game.stake * 2;
      const prize = Math.floor(totalBank * 0.9);

      const winnerRef = db.collection('users').doc(game.players[winnerIdx].id);
      const loserRef = db.collection('users').doc(game.players[loserIdx].id);

      const winnerDoc = await winnerRef.get();
      const loserDoc = await loserRef.get();

      if (winnerDoc.exists) {
        const wData = winnerDoc.data();
        await winnerRef.update({
          wins: (wData.wins || 0) + 1,
          stars_balance: (wData.stars_balance || 0) + prize
        });
        await updateQuestProgress(wData.telegram_id, 'win');
      }

      if (loserDoc.exists) {
        const lData = loserDoc.data();
        await loserRef.update({
          losses: (lData.losses || 0) + 1
        });
      }

      const freshWinner = await winnerRef.get();
      const freshLoser = await loserRef.get();

      io.sockets.sockets.forEach((s) => {
        if (s.userId === game.players[winnerIdx].id) {
          s.emit('game_over', { won: true, prize });
          if (winnerDoc.exists) s.emit('auth_success', freshWinner.data());
        } else if (s.userId === game.players[loserIdx].id) {
          s.emit('game_over', { won: false, prize: 0 });
          if (loserDoc.exists) s.emit('auth_success', freshLoser.data());
        }
      });
      delete activeGames[gameId];
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CardFool Firebase Firestore Secured Server running on port ${PORT}`));
