const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// 방 상태 저장 (메모리)
let roomState = {
  isOpen: false,
  hostId: null,
  members: [],   // { id, name, role: 'host' | 'admin' | 'member' }
  waitList: []   // { id, name }
};

function broadcastRoomData() {
  io.to('chat-room').emit('members-update', roomState.members);
  if (roomState.hostId) {
    io.to(roomState.hostId).emit('waitlist-update', roomState.waitList);
  }
}

io.on('connection', (socket) => {
  // 1. 방장 로그인
  socket.on('host-login', ({ name, password }, callback) => {
    if (password !== 'qwer1234yjw@') {
      return callback({ success: false, message: '비밀번호가 일치하지 않습니다.' });
    }
    if (roomState.isOpen && roomState.hostId) {
      return callback({ success: false, message: '이미 방장이 방을 열어두었습니다.' });
    }

    roomState.isOpen = true;
    roomState.hostId = socket.id;
    roomState.members = [{ id: socket.id, name, role: 'host' }];
    roomState.waitList = [];

    socket.join('chat-room');
    callback({ success: true, members: roomState.members });
    io.emit('room-status', { isOpen: true });
  });

  // 2. 일반 유저 입장 요청
  socket.on('request-entry', ({ name }, callback) => {
    if (!roomState.isOpen) {
      return callback({ success: false, message: '현재 방장이 방을 열지 않았습니다. 방장이 먼저 입장해야 합니다.' });
    }

    // 중복 대기 방지 후 대기열 추가
    roomState.waitList = roomState.waitList.filter(u => u.id !== socket.id);
    roomState.waitList.push({ id: socket.id, name });

    callback({ success: true });
    if (roomState.hostId) {
      io.to(roomState.hostId).emit('waitlist-update', roomState.waitList);
    }
  });

  // 3. 방장의 수락 / 거절 처리
  socket.on('decide-wait', ({ targetId, accept }) => {
    if (socket.id !== roomState.hostId) return;

    const userIndex = roomState.waitList.findIndex(u => u.id === targetId);
    if (userIndex === -1) return;

    const targetUser = roomState.waitList[userIndex];
    roomState.waitList.splice(userIndex, 1);

    if (accept) {
      io.to(targetId).emit('entry-accepted');
    } else {
      io.to(targetId).emit('entry-rejected');
    }
    io.to(roomState.hostId).emit('waitlist-update', roomState.waitList);
  });

  // 4. 수락된 유저의 실제 채팅방 진입 ('바로 들어가기' 클릭 시)
  socket.on('join-chat', ({ name }) => {
    if (!roomState.isOpen) return;
    if (!roomState.members.find(m => m.id === socket.id)) {
      roomState.members.push({ id: socket.id, name, role: 'member' });
    }
    socket.join('chat-room');
    broadcastRoomData();
    io.to('chat-room').emit('sys-msg', `✅ ${name}님이 입장했습니다.`);
  });

  // 5. 채팅 메시지 전송
  socket.on('send-msg', ({ text }) => {
    const sender = roomState.members.find(m => m.id === socket.id);
    if (!sender) return;

    io.to('chat-room').emit('receive-msg', {
      senderId: socket.id,
      sender: sender.name,
      role: sender.role,
      text
    });
  });

  // 6. 방장 특별 기능: 관리자 권한 부여/해제
  socket.on('toggle-admin', ({ targetId }) => {
    if (socket.id !== roomState.hostId) return;
    const target = roomState.members.find(m => m.id === targetId);
    if (!target || target.role === 'host') return;

    target.role = target.role === 'admin' ? 'member' : 'admin';
    broadcastRoomData();
    io.to('chat-room').emit('sys-msg', `👑 ${target.name}님의 권한이 [${target.role === 'admin' ? '관리자' : '일반'}]로 변경되었습니다.`);
  });

  // 7. 방장 특별 기능: 내보내기
  socket.on('kick-member', ({ targetId }) => {
    if (socket.id !== roomState.hostId) return;
    const idx = roomState.members.findIndex(m => m.id === targetId);
    if (idx === -1 || roomState.members[idx].role === 'host') return;

    const kickedUser = roomState.members[idx];
    roomState.members.splice(idx, 1);

    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) {
      targetSocket.leave('chat-room');
      targetSocket.emit('kicked');
    }

    broadcastRoomData();
    io.to('chat-room').emit('sys-msg', `🚫 방장이 ${kickedUser.name}님을 내보냈습니다.`);
  });

  // 8. 방장 기능: 방 닫기
  socket.on('close-room', () => {
    if (socket.id !== roomState.hostId) return;
    io.to('chat-room').emit('room-closed');
    roomState = { isOpen: false, hostId: null, members: [], waitList: [] };
  });

  // 9. 실시간 음성 통화 (WebRTC 시그널링 중계)
  socket.on('call-start', () => {
    const caller = roomState.members.find(m => m.id === socket.id);
    if (!caller) return;
    io.to('chat-room').emit('sys-msg', `📞 ${caller.name}님이 음성 통화에 참여했습니다.`);
    socket.to('chat-room').emit('user-joined-call', { userId: socket.id });
  });

  socket.on('webrtc-signal', ({ to, signal }) => {
    io.to(to).emit('webrtc-signal', { from: socket.id, signal });
  });

  // 10. 연결 종료 처리
  socket.on('disconnect', () => {
    // 대기열에서 제거
    const waitIdx = roomState.waitList.findIndex(u => u.id === socket.id);
    if (waitIdx !== -1) {
      roomState.waitList.splice(waitIdx, 1);
      if (roomState.hostId) io.to(roomState.hostId).emit('waitlist-update', roomState.waitList);
    }

    // 방장이 나간 경우 방 닫기
    if (socket.id === roomState.hostId) {
      io.to('chat-room').emit('room-closed');
      roomState = { isOpen: false, hostId: null, members: [], waitList: [] };
      return;
    }

    // 참여자에서 제거
    const memIdx = roomState.members.findIndex(m => m.id === socket.id);
    if (memIdx !== -1) {
      const leftUser = roomState.members[memIdx];
      roomState.members.splice(memIdx, 1);
      broadcastRoomData();
      io.to('chat-room').emit('sys-msg', `${leftUser.name}님이 퇴장했습니다.`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
