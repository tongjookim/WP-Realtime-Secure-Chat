# 설치 및 운영 가이드

## 1단계: WordPress 플러그인 설치

```bash
# 워드프레스 플러그인 디렉토리에 복사
cp -r wordpress-plugin /path/to/wordpress/wp-content/plugins/wp-realtime-chat

# Composer 의존성 설치 (firebase/php-jwt)
cd /path/to/wordpress/wp-content/plugins/wp-realtime-chat
composer install --no-dev
```

워드프레스 관리자 → 플러그인 → "WP Realtime Secure Chat" 활성화

## 2단계: Node.js 서버 설정

```bash
cd node-server

# 의존성 설치
npm install

# 환경 설정
cp .env.example .env

# .env 편집 - JWT_SECRET을 WP 관리자 페이지의 값과 동일하게 설정
# ALLOWED_ORIGINS에 워드프레스 사이트 URL 추가
nano .env
```

## 3단계: JWT 시크릿 키 동기화

1. WP 관리자 → 설정 → 실시간 채팅 → JWT 시크릿 키 확인
2. Node.js 서버의 `.env` 파일에 동일한 키 설정
3. **반드시 두 서버의 키가 일치해야 인증이 작동합니다**

## 4단계: Node.js 서버 실행

```bash
# 개발 모드 (auto-reload)
npm run dev

# 프로덕션 모드
npm start

# PM2 사용 시 (권장)
pm2 start server.js --name "wprc-chat"
pm2 save
pm2 startup
```

## 5단계: 워드프레스 페이지에 채팅 삽입

원하는 페이지/포스트 편집기에서:
```
[realtime_chat]
```
또는 높이 지정:
```
[realtime_chat height="700"]
```

## 프로덕션 배포 시 필수 사항

### HTTPS/WSS 설정 (Nginx 리버스 프록시)
```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### WP 관리자 설정 변경
- Node.js 서버 URL을 `https://chat.example.com`으로 변경
- ALLOWED_ORIGINS에 워드프레스 사이트 도메인 추가

### 보안 체크리스트
- [ ] JWT 시크릿 키가 충분히 긴 랜덤 문자열인지 확인 (64자 이상 권장)
- [ ] HTTPS/WSS 적용 확인
- [ ] ALLOWED_ORIGINS에 정확한 도메인만 등록
- [ ] 방화벽에서 소켓 서버 포트(3200) 접근 제한
- [ ] PM2 또는 systemd로 Node.js 프로세스 관리
