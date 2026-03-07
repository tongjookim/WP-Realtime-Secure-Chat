<?php
/**
 * Plugin Name: WP Realtime Secure Chat
 * Description: Node.js 기반 실시간 보안 채팅 플러그인 - 대화 내용이 어떤 DB에도 저장되지 않는 완전 휘발성 채팅
 * Version: 1.0.0
 * Author: Developer
 * Text Domain: wp-realtime-chat
 * Requires PHP: 7.4
 */

if (!defined('ABSPATH')) {
    exit;
}

define('WPRC_VERSION', '1.0.0');
define('WPRC_PLUGIN_DIR', plugin_dir_path(__FILE__));
define('WPRC_PLUGIN_URL', plugin_dir_url(__FILE__));

// Composer autoload (firebase/php-jwt)
if (file_exists(WPRC_PLUGIN_DIR . 'vendor/autoload.php')) {
    require_once WPRC_PLUGIN_DIR . 'vendor/autoload.php';
}

// 핵심 클래스 로드
require_once WPRC_PLUGIN_DIR . 'includes/class-jwt-handler.php';
require_once WPRC_PLUGIN_DIR . 'includes/class-admin-settings.php';
require_once WPRC_PLUGIN_DIR . 'includes/class-shortcode.php';
require_once WPRC_PLUGIN_DIR . 'includes/class-rest-api.php';

class WP_Realtime_Chat {

    private static $instance = null;
    private $jwt_handler;
    private $admin_settings;
    private $shortcode;
    private $rest_api;

    public static function get_instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        $this->jwt_handler    = new WPRC_JWT_Handler();
        $this->admin_settings = new WPRC_Admin_Settings();
        $this->shortcode      = new WPRC_Shortcode($this->jwt_handler);
        $this->rest_api       = new WPRC_REST_API($this->jwt_handler);

        add_action('wp_enqueue_scripts', [$this, 'enqueue_frontend_assets']);
        add_action('admin_enqueue_scripts', [$this, 'enqueue_admin_assets']);
        add_shortcode('realtime_chat_float', [$this->shortcode, 'render']); // 플로팅 전용 숏코드 (선택)

        // 임시 파일 자동 삭제 크론 핸들러 연결
        add_action('wprc_cleanup_temp_files', [$this->shortcode, 'cleanup_temp_files']);

        register_activation_hook(__FILE__, [$this, 'activate']);
        register_deactivation_hook(__FILE__, [$this, 'deactivate']);
    }

    /**
     * 프론트엔드 에셋 로드
     * - 플로팅 채팅: 모든 페이지에 로드 (관리자 제외)
     * - 풀페이지 채팅: [realtime_chat] 숏코드 페이지에도 동일 에셋 사용
     */
    public function enqueue_frontend_assets() {
        if (is_admin()) return;

        $node_server_url = get_option('wprc_node_server_url', 'http://localhost:3200');
        $current_user    = wp_get_current_user();
        $is_logged_in    = is_user_logged_in();

        $js_config = [
            'nodeServerUrl' => $node_server_url,
            'restUrl'       => rest_url('wprc/v1/'),
            'wpMediaUrl'    => rest_url('wp/v2/media'), // 🚀 이미지 업로드용 추가
            'nonce'         => wp_create_nonce('wp_rest'),
            'isLoggedIn'    => $is_logged_in,
            'userId'        => $is_logged_in ? $current_user->ID : 0,
            'displayName'   => $is_logged_in ? $current_user->display_name : '게스트', // 🚀 기본값 추가
            'avatarUrl'     => $is_logged_in ? get_avatar_url($current_user->ID) : '', // 🚀 아바타 추가
            'token'         => $is_logged_in ? $this->jwt_handler->generate_token($current_user) : '',
            'pluginUrl'     => WPRC_PLUGIN_URL,
            'version'       => WPRC_VERSION,
            'allowGuests'   => (bool) get_option('wprc_allow_guests', true), // 🚀 게스트 허용 여부 추가
        ];

        // ── 모든 페이지: 채팅 에셋 등록만 해두고 숏코드 실행 시 enqueue ──
        // has_shortcode()는 페이지빌더 환경에서 오동작하므로 사용하지 않음
        wp_register_style('font-awesome', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css');
        wp_register_style('wprc-chat-style', WPRC_PLUGIN_URL . 'assets/css/chat.css', [], WPRC_VERSION);
        wp_register_script('socket-io-client', $node_server_url . '/socket.io/socket.io.js', [], '4.7.0', true);
        wp_register_script('wprc-chat-client', WPRC_PLUGIN_URL . 'assets/js/chat-client-v2.js', ['socket-io-client'], WPRC_VERSION, true);
        wp_register_script('wprc-chat-client-mobile', WPRC_PLUGIN_URL . 'assets/js/chat-client-mobile.js', ['socket-io-client'], WPRC_VERSION, true);

        // WPRC_Config는 숏코드 render() 안에서 localize함 (해당 페이지만 적용)

        // ── 모든 페이지: 플로팅 버튼 ──
        wp_enqueue_style('wprc-float-style', WPRC_PLUGIN_URL . 'assets/css/chat-float.css', [], WPRC_VERSION);
        wp_enqueue_script('wprc-chat-float', WPRC_PLUGIN_URL . 'assets/js/chat-float.js', [], WPRC_VERSION, true);
        wp_localize_script('wprc-chat-float', 'WPRC_Config', $js_config);
        add_action('wp_footer', [$this, 'render_float_widget']);
    }

    /**
     * 모든 페이지 footer에 플로팅 채팅 버튼 + 모달 컨테이너 출력
     */
    public function render_float_widget() {
        if (!is_user_logged_in() && !get_option('wprc_allow_guests', true)) return;

        // 숏코드([realtime_chat])가 있는 페이지에선 플로팅 버튼 출력 안 함
        global $post;
        if (is_a($post, 'WP_Post') && has_shortcode($post->post_content, 'realtime_chat')) return;
        ?>
        <div id="wprc-float-wrap">
            <!-- 플로팅 버튼 -->
            <button id="wprc-float-btn" aria-label="채팅 열기">
                <svg id="wprc-float-icon-open" xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="white">
                    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
                </svg>
                <svg id="wprc-float-icon-close" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white" style="display:none;">
                    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
                <span id="wprc-float-badge" style="display:none;"></span>
            </button>
            <!-- 모달 컨테이너: 채팅 UI가 여기에 렌더링됨 -->
            <div id="wprc-float-modal" style="display:none;"></div>
        </div>
        <?php
    }

    public function enqueue_admin_assets($hook) {
        if ($hook !== 'settings_page_wprc-settings') {
            return;
        }
        wp_enqueue_style('wprc-admin-style', WPRC_PLUGIN_URL . 'assets/css/admin.css', [], WPRC_VERSION);
    }

    public function activate() {
        // JWT 시크릿 키 자동 생성 (최초 1회)
        if (!get_option('wprc_jwt_secret')) {
            update_option('wprc_jwt_secret', wp_generate_password(64, true, true));
        }
        if (!get_option('wprc_node_server_url')) {
            update_option('wprc_node_server_url', 'http://localhost:3200');
        }
        // 임시 파일 자동 삭제 크론 등록 (1시간마다)
        if (!wp_next_scheduled('wprc_cleanup_temp_files')) {
            wp_schedule_event(time(), 'hourly', 'wprc_cleanup_temp_files');
        }
        flush_rewrite_rules();
    }

    public function deactivate() {
        // 크론 해제
        wp_clear_scheduled_hook('wprc_cleanup_temp_files');
        flush_rewrite_rules();
    }
}

// 플러그인 초기화
WP_Realtime_Chat::get_instance();
