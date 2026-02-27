<?php
/**
 * REST API 엔드포인트
 * - 게스트 토큰 발급
 * - 사용자 목록 조회 (친구 목록용)
 */

class WPRC_REST_API {

    private $jwt_handler;

    public function __construct(WPRC_JWT_Handler $jwt_handler) {
        $this->jwt_handler = $jwt_handler;
        add_action('rest_api_init', [$this, 'register_routes']);
    }

    public function register_routes() {
        $namespace = 'wprc/v1';

        // 게스트 토큰 발급
        register_rest_route($namespace, '/guest-token', [
            'methods'             => 'POST',
            'callback'            => [$this, 'issue_guest_token'],
            'permission_callback' => '__return_true',
            'args'                => [
                'nickname' => [
                    'required'          => true,
                    'type'              => 'string',
                    'sanitize_callback' => 'sanitize_text_field',
                    'validate_callback' => function ($value) {
                        $len = mb_strlen(trim($value));
                        return $len >= 1 && $len <= 20;
                    },
                ],
            ],
        ]);

        // 워드프레스 사용자 목록 (친구 목록 기반)
        register_rest_route($namespace, '/users', [
            'methods'             => 'GET',
            'callback'            => [$this, 'get_users'],
            'permission_callback' => function () {
                return is_user_logged_in();
            },
        ]);

        // JWT 시크릿 키 확인 (관리자 전용, Node.js 서버 설정용)
        register_rest_route($namespace, '/secret-key', [
            'methods'             => 'GET',
            'callback'            => [$this, 'get_secret_key'],
            'permission_callback' => function () {
                return current_user_can('manage_options');
            },
        ]);
    }

    /**
     * 게스트 JWT 토큰 발급
     */
    public function issue_guest_token(WP_REST_Request $request): WP_REST_Response {
        if (!get_option('wprc_allow_guests', true)) {
            return new WP_REST_Response([
                'success' => false,
                'message' => '게스트 접속이 비활성화되어 있습니다.',
            ], 403);
        }

        $nickname = $request->get_param('nickname');

        // Rate limiting (간단한 IP 기반 제한)
        $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
        $transient_key = 'wprc_guest_limit_' . md5($ip);
        $attempts = get_transient($transient_key) ?: 0;

        if ($attempts >= 5) {
            return new WP_REST_Response([
                'success' => false,
                'message' => '잠시 후 다시 시도해주세요.',
            ], 429);
        }

        set_transient($transient_key, $attempts + 1, 300); // 5분 내 5회 제한

        $token = $this->jwt_handler->generate_guest_token($nickname);

        return new WP_REST_Response([
            'success' => true,
            'token'   => $token,
        ], 200);
    }

    /**
     * WP 사용자 목록 조회 (기본 친구 목록)
     */
    public function get_users(WP_REST_Request $request): WP_REST_Response {
        $current_user_id = get_current_user_id();

        $users = get_users([
            'exclude' => [$current_user_id],
            'number'  => 100,
            'orderby' => 'display_name',
            'fields'  => ['ID', 'display_name', 'user_login'],
        ]);

        $result = array_map(function ($user) {
            return [
                'id'           => $user->ID,
                'display_name' => $user->display_name,
                'username'     => $user->user_login,
                'avatar_url'   => get_avatar_url($user->ID, ['size' => 48]),
            ];
        }, $users);

        return new WP_REST_Response([
            'success' => true,
            'users'   => $result,
        ], 200);
    }

    /**
     * JWT 시크릿 키 조회 (관리자 전용)
     */
    public function get_secret_key(): WP_REST_Response {
        return new WP_REST_Response([
            'secret_key' => $this->jwt_handler->get_secret_key(),
            'note'       => 'Node.js 서버 .env 파일의 JWT_SECRET에 이 값을 설정하세요.',
        ], 200);
    }
}
