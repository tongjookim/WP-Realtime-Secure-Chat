<?php
/**
 * JWT 토큰 생성 및 검증 핸들러
 * firebase/php-jwt 라이브러리 사용
 */

use Firebase\JWT\JWT;
use Firebase\JWT\Key;

class WPRC_JWT_Handler {

    private $secret_key;
    private $algorithm = 'HS256';
    private $token_expiry = 86400; // 24시간

    public function __construct() {
        $this->secret_key = get_option('wprc_jwt_secret', 'change-this-secret-key');
    }

    /**
     * WP 로그인 사용자용 JWT 토큰 생성
     */
    public function generate_token(WP_User $user): string {
        $issued_at = time();

        $payload = [
            'iss'  => get_bloginfo('url'),          // 발급자
            'iat'  => $issued_at,                    // 발급 시간
            'exp'  => $issued_at + $this->token_expiry, // 만료 시간
            'sub'  => $user->ID,                     // 사용자 ID
            'data' => [
                'user_id'      => $user->ID,
                'username'     => $user->user_login,
                'display_name' => $user->display_name,
                'email'        => $user->user_email,
                'avatar_url'   => get_avatar_url($user->ID, ['size' => 96]),
                'is_guest'     => false,
            ],
        ];

        return JWT::encode($payload, $this->secret_key, $this->algorithm);
    }

    /**
     * 비회원(게스트) 사용자용 JWT 토큰 생성
     */
    public function generate_guest_token(string $nickname): string {
        $issued_at = time();
        $guest_id  = 'guest_' . wp_generate_password(12, false);

        // 닉네임 검증 (XSS 방지)
        $nickname = sanitize_text_field($nickname);
        if (empty($nickname) || mb_strlen($nickname) > 20) {
            $nickname = '익명' . rand(1000, 9999);
        }

        $payload = [
            'iss'  => get_bloginfo('url'),
            'iat'  => $issued_at,
            'exp'  => $issued_at + $this->token_expiry,
            'sub'  => $guest_id,
            'data' => [
                'user_id'      => $guest_id,
                'username'     => $guest_id,
                'display_name' => $nickname,
                'email'        => '',
                'avatar_url'   => get_avatar_url(0, ['size' => 96]),
                'is_guest'     => true,
            ],
        ];

        return JWT::encode($payload, $this->secret_key, $this->algorithm);
    }

    /**
     * JWT 토큰 검증
     */
    public function verify_token(string $token): ?object {
        try {
            $decoded = JWT::decode($token, new Key($this->secret_key, $this->algorithm));
            return $decoded;
        } catch (\Exception $e) {
            error_log('[WPRC] JWT verification failed: ' . $e->getMessage());
            return null;
        }
    }

    /**
     * JWT 시크릿 키 반환 (Node.js 서버와 공유용)
     */
    public function get_secret_key(): string {
        return $this->secret_key;
    }
}
