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

        register_activation_hook(__FILE__, [$this, 'activate']);
        register_deactivation_hook(__FILE__, [$this, 'deactivate']);
    }

    /**
     * 프론트엔드 에셋 로드 (숏코드가 있는 페이지에서만)
     */
    public function enqueue_frontend_assets() {
        global $post;

        if (!is_a($post, 'WP_Post') || !has_shortcode($post->post_content, 'realtime_chat')) {
            return;
        }

        $node_server_url = get_option('wprc_node_server_url', 'http://localhost:3200');

        // Socket.io 클라이언트
        wp_enqueue_script(
            'socket-io-client',
            $node_server_url . '/socket.io/socket.io.js',
            [],
            '4.7.0',
            true
        );

        // 채팅 CSS
        wp_enqueue_style(
            'wprc-chat-style',
            WPRC_PLUGIN_URL . 'assets/css/chat.css',
            [],
            WPRC_VERSION
        );

        // 채팅 클라이언트 JS
        wp_enqueue_script(
            'wprc-chat-client',
            WPRC_PLUGIN_URL . 'assets/js/chat-client.js',
            ['socket-io-client'],
            WPRC_VERSION,
            true
        );

        // JS에 전달할 설정값
        $current_user = wp_get_current_user();
        $is_logged_in = is_user_logged_in();

        $js_config = [
            'nodeServerUrl' => $node_server_url,
            'restUrl'       => rest_url('wprc/v1/'),
            'nonce'         => wp_create_nonce('wp_rest'),
            'isLoggedIn'    => $is_logged_in,
            'userId'        => $is_logged_in ? $current_user->ID : 0,
            'displayName'   => $is_logged_in ? $current_user->display_name : '',
            'token'         => $is_logged_in ? $this->jwt_handler->generate_token($current_user) : '',
        ];

        wp_localize_script('wprc-chat-client', 'WPRC_Config', $js_config);
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
        flush_rewrite_rules();
    }

    public function deactivate() {
        flush_rewrite_rules();
    }
}

// 플러그인 초기화
WP_Realtime_Chat::get_instance();
