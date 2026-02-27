# WP Realtime Secure Chat - 시스템 아키텍처

## 1. 전체 구조도

```
┌─────────────────────────────────────────────────────────┐
│                    WordPress Server                      │
│  ┌───────────────────────────────────────────────────┐  │
│  │          wp-realtime-chat (Plugin)                 │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌──────────┐ │  │
│  │  │  Shortcode   │  │  JWT Token   │  │  Admin   │ │  │
│  │  │  Renderer    │  │  Generator   │  │  Settings│ │  │
│  │  └──────┬──────┘  └──────┬───────┘  └────┬─────┘ │  │
│  └─────────┼───────────────┼────────────────┼────────┘  │
│            │               │                │            │
│  ┌─────────▼───────────────▼────────────────▼────────┐  │
│  │              Frontend (Vanilla JS)                 │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │  │
│  │  │ Chat UI  │ │ Room Mgr │ │ Socket.io Client  │ │  │
│  │  └──────────┘ └──────────┘ └────────┬──────────┘ │  │
│  └─────────────────────────────────────┼─────────────┘  │
└────────────────────────────────────────┼────────────────┘
                                         │ WebSocket (wss://)
                                         │ + JWT Auth
┌────────────────────────────────────────▼────────────────┐
│                   Node.js Server                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │                 Socket.io Server                   │  │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │  │
│  │  │ JWT Auth │ │ Room Mgr │ │ Presence Tracker  │ │  │
│  │  │Middleware│ │ (Memory) │ │   (Memory)        │ │  │
│  │  └──────────┘ └──────────┘ └───────────────────┘ │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │     In-Memory Message Broker (NO DB)        │  │  │
│  │  │  - 메시지 브로드캐스트 후 즉시 폐기          │  │  │
│  │  │  - 세션 종료 시 모든 데이터 휘발             │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## 2. 데이터 흐름

### 인증 흐름
1. WP 로그인 사용자: WP 세션 → PHP에서 JWT 생성 → JS에 전달 → Socket 연결 시 JWT 검증
2. 비회원 사용자: 닉네임 입력 → PHP에서 게스트 JWT 생성 (AJAX) → Socket 연결

### 메시지 흐름
1. 사용자 A가 메시지 전송 → Socket.io emit('message')
2. Node.js 서버 수신 → 해당 Room의 참여자에게만 broadcast
3. **메시지는 서버 메모리에 저장하지 않음** → broadcast 후 즉시 폐기
4. 수신 측 브라우저에서만 DOM에 렌더링 (새로고침 시 소멸)

### 보안 설계 원칙
- **Zero Persistence**: 어떤 DB에도 대화 내용을 기록하지 않음
- **Memory-Only Broadcast**: 서버는 메시지를 중계만 하고 보관하지 않음
- **Session Volatile**: 브라우저 새로고침 또는 소켓 연결 해제 시 클라이언트 측 대화 내용도 소멸
- **JWT 기반 인증**: WP 사용자 정보를 안전하게 Node.js 서버에 전달

## 3. 기술 스택

| 구분 | 기술 | 역할 |
|------|------|------|
| WordPress Plugin | PHP 7.4+ | 숏코드, JWT 발급, 관리자 설정 |
| Socket Server | Node.js 18+ / Socket.io 4.x | 실시간 메시지 중계, 접속 상태 관리 |
| Frontend | Vanilla JS + Socket.io Client | 채팅 UI, 소켓 통신 |
| 인증 | JWT (firebase/php-jwt) | 사용자 인증 토큰 |
| 보안 | HTTPS/WSS 필수 권장 | 통신 암호화 |

## 4. 파일 구조

```
wp-realtime-chat/
├── wordpress-plugin/
│   ├── wp-realtime-chat.php          # 메인 플러그인 파일
│   ├── includes/
│   │   ├── class-jwt-handler.php     # JWT 생성/검증
│   │   ├── class-admin-settings.php  # 관리자 설정 페이지
│   │   ├── class-shortcode.php       # 숏코드 처리
│   │   └── class-rest-api.php        # REST API 엔드포인트
│   ├── assets/
│   │   ├── css/
│   │   │   └── chat.css              # 채팅 UI 스타일
│   │   └── js/
│   │       └── chat-client.js        # 소켓 클라이언트 + UI 로직
│   └── composer.json                 # firebase/php-jwt 의존성
│
├── node-server/
│   ├── server.js                     # 메인 Socket.io 서버
│   ├── auth.js                       # JWT 검증 미들웨어
│   ├── roomManager.js                # 방 관리 (메모리)
│   ├── presenceManager.js            # 접속 상태 관리
│   ├── package.json                  # Node.js 의존성
│   └── .env.example                  # 환경 변수 템플릿
│
└── ARCHITECTURE.md                   # 이 문서
```
