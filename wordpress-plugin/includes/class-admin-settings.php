<?php
/**
 * 관리자 설정 페이지
 */

class WPRC_Admin_Settings {

    public function __construct() {
        add_action('admin_menu', [$this, 'add_settings_page']);
        add_action('admin_init', [$this, 'register_settings']);
    }

    public function add_settings_page() {
        add_options_page(
            '실시간 채팅 설정',
            '실시간 채팅',
            'manage_options',
            'wprc-settings',
            [$this, 'render_settings_page']
        );
    }

    public function register_settings() {
        // Node.js 서버 URL
        register_setting('wprc_settings_group', 'wprc_node_server_url', [
            'type'              => 'string',
            'sanitize_callback' => 'esc_url_raw',
            'default'           => 'http://localhost:3200',
        ]);

        // JWT 시크릿 키
        register_setting('wprc_settings_group', 'wprc_jwt_secret', [
            'type'              => 'string',
            'sanitize_callback' => 'sanitize_text_field',
        ]);

        // 게스트 접속 허용 여부
        register_setting('wprc_settings_group', 'wprc_allow_guests', [
            'type'    => 'boolean',
            'default' => true,
        ]);

        // 최대 채팅방 인원
        register_setting('wprc_settings_group', 'wprc_max_room_users', [
            'type'    => 'integer',
            'default' => 50,
        ]);

        // 설정 섹션
        add_settings_section(
            'wprc_main_section',
            '서버 연결 설정',
            null,
            'wprc-settings'
        );

        add_settings_field('wprc_node_server_url', 'Node.js 서버 URL', [$this, 'field_node_url'], 'wprc-settings', 'wprc_main_section');
        add_settings_field('wprc_jwt_secret', 'JWT 시크릿 키', [$this, 'field_jwt_secret'], 'wprc-settings', 'wprc_main_section');
        add_settings_field('wprc_allow_guests', '게스트 접속 허용', [$this, 'field_allow_guests'], 'wprc-settings', 'wprc_main_section');
        add_settings_field('wprc_max_room_users', '방 최대 인원', [$this, 'field_max_room_users'], 'wprc-settings', 'wprc_main_section');
    }

    public function field_node_url() {
        $value = get_option('wprc_node_server_url', 'http://localhost:3200');
        echo '<input type="url" name="wprc_node_server_url" value="' . esc_attr($value) . '" class="regular-text" />';
        echo '<p class="description">Node.js 소켓 서버의 URL (예: https://chat.example.com:3200)</p>';
    }

    public function field_jwt_secret() {
        $value = get_option('wprc_jwt_secret', '');
        echo '<input type="text" name="wprc_jwt_secret" value="' . esc_attr($value) . '" class="regular-text" />';
        echo '<p class="description">⚠️ 이 키는 Node.js 서버의 .env 파일에도 동일하게 설정해야 합니다.</p>';
    }

    public function field_allow_guests() {
        $checked = get_option('wprc_allow_guests', true);
        echo '<label><input type="checkbox" name="wprc_allow_guests" value="1" ' . checked($checked, true, false) . ' /> 비로그인 사용자도 채팅 참여 가능</label>';
    }

    public function field_max_room_users() {
        $value = get_option('wprc_max_room_users', 50);
        echo '<input type="number" name="wprc_max_room_users" value="' . esc_attr($value) . '" min="2" max="500" />';
    }

    public function render_settings_page() {
        if (!current_user_can('manage_options')) {
            return;
        }
        ?>
        <div class="wrap">
            <h1>실시간 보안 채팅 설정</h1>
            <div class="notice notice-info">
                <p><strong>사용법:</strong> 원하는 페이지에 <code>[realtime_chat]</code> 숏코드를 삽입하세요.</p>
                <p><strong>보안 안내:</strong> 모든 대화 내용은 서버 메모리에서만 중계되며, 어떤 데이터베이스에도 저장되지 않습니다.</p>
            </div>
            <form method="post" action="options.php">
                <?php
                settings_fields('wprc_settings_group');
                do_settings_sections('wprc-settings');
                submit_button('설정 저장');
                ?>
            </form>

            <hr>
            <h2>Node.js 서버 상태</h2>
            <div id="wprc-server-status">
                <button type="button" class="button" onclick="checkServerStatus()">서버 연결 확인</button>
                <span id="wprc-status-result"></span>
            </div>
            <script>
            function checkServerStatus() {
                const url = '<?php echo esc_js(get_option('wprc_node_server_url', 'http://localhost:3200')); ?>';
                const resultEl = document.getElementById('wprc-status-result');
                resultEl.textContent = ' 확인 중...';
                fetch(url + '/health')
                    .then(r => r.json())
                    .then(data => {
                        resultEl.innerHTML = ' <span style="color:green;">✅ 연결 성공 - 접속자: ' + (data.connections || 0) + '명</span>';
                    })
                    .catch(() => {
                        resultEl.innerHTML = ' <span style="color:red;">❌ 연결 실패 - Node.js 서버를 확인하세요.</span>';
                    });
            }
            </script>
        </div>
        <?php
    }
}
