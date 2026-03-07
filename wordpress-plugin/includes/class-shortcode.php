<?php
/**
 * 숏코드 처리 - 채팅 UI 렌더링
 * 사용법: [realtime_chat] 또는 [realtime_chat height="600"]
 */

class WPRC_Shortcode {

    private $jwt_handler;

    public function __construct(WPRC_JWT_Handler $jwt_handler) {
        $this->jwt_handler = $jwt_handler;
        add_shortcode('realtime_chat', [$this, 'render']);
        add_action('rest_api_init', [$this, 'register_upload_route']);
    }

    /**
     * 플러그인 이미지 업로드 엔드포인트 (JWT 인증)
     * POST /wp-json/wprc/v1/upload-image
     * Authorization: Bearer <jwt_token>
     * 쿠키/Nonce 인증 불필요 → 모바일에서도 안정적으로 동작
     */
    public function register_upload_route() {
        register_rest_route('wprc/v1', '/upload-image', [
            'methods'             => 'POST',
            'callback'            => [$this, 'handle_image_upload'],
            'permission_callback' => '__return_true', // 인증은 콜백 내부에서 JWT로 처리
        ]);
    }

    public function handle_image_upload(\WP_REST_Request $request) {
        @ini_set('memory_limit', '256M');

        // ── 단계별 디버그 로그 (문제 해결 후 제거 예정) ──
        $log = function($msg) {
            error_log('[WPRC-UPLOAD] ' . $msg);
        };

        $log('=== 업로드 시작 ===');

        // ── JWT 인증 ──
        // Apache가 Authorization 헤더를 PHP에 전달하지 않는 경우가 많아
        // 4가지 방법으로 토큰을 추출 (하나라도 성공하면 됨)
        $token = '';

        // 방법 1: Authorization: Bearer <token> (nginx 또는 .htaccess 설정 시)
        $auth_header = $request->get_header('Authorization');
        if ($auth_header && preg_match('/^Bearer\s+(.+)$/i', $auth_header, $m)) {
            $token = trim($m[1]);
        }

        // 방법 2: X-WPRC-Token 커스텀 헤더 (Apache Authorization 차단 우회)
        if (!$token) {
            $token = $request->get_header('X-WPRC-Token') ?: '';
        }

        // 방법 3: HTTP_AUTHORIZATION 서버 변수 (일부 Apache 환경)
        if (!$token && !empty($_SERVER['HTTP_AUTHORIZATION'])) {
            if (preg_match('/^Bearer\s+(.+)$/i', $_SERVER['HTTP_AUTHORIZATION'], $m)) {
                $token = trim($m[1]);
            }
        }

        // 방법 4: URL 쿼리 파라미터 ?_wprc_token=... (헤더 전달 완전 불가 시 fallback)
        if (!$token) {
            $token = $request->get_param('_wprc_token') ?: '';
        }

        $log('token 추출: ' . ($token ? '성공 ('.strlen($token).'자)' : '실패 - 모든 방법 시도함'));

        if (!$token) {
            return new \WP_Error('no_token', '인증 토큰이 필요합니다.', ['status' => 401]);
        }

        try {
            $payload = $this->jwt_handler->verify_token($token);
        } catch (\Throwable $e) {
            $log('verify_token 예외: ' . $e->getMessage());
            return new \WP_Error('token_exception', 'JWT 처리 오류: ' . $e->getMessage(), ['status' => 401]);
        }

        if (!$payload) {
            $log('FAIL: JWT 검증 실패 (payload null)');
            return new \WP_Error('invalid_token', '유효하지 않은 토큰입니다.', ['status' => 401]);
        }
        $log('JWT 검증 OK, payload: ' . json_encode($payload));

        $user_id = 0;
        if (!empty($payload->user_id))            $user_id = (int) $payload->user_id;
        elseif (!empty($payload->sub))            $user_id = (int) $payload->sub;
        elseif (!empty($payload->data->user->id)) $user_id = (int) $payload->data->user->id;

        if (!$user_id) {
            $log('FAIL: payload에서 user_id 추출 불가');
            return new \WP_Error('invalid_token', '토큰에서 사용자 정보를 찾을 수 없습니다.', ['status' => 401]);
        }
        $log("user_id: $user_id");

        $user = get_user_by('id', $user_id);
        if (!$user) {
            return new \WP_Error('invalid_user', '존재하지 않는 사용자입니다.', ['status' => 401]);
        }
        // JWT 인증 통과 = 업로드 허용 (구독자 포함, 임시폴더 저장 후 1시간 뒤 자동 삭제)
        $log('user OK: ' . $user_id . ' roles=' . implode(',', (array)$user->roles));

        // ── 파일 수신 확인 ──
        $files = $request->get_file_params();
        $log('수신 파일 목록: ' . json_encode(array_keys($files)));

        if (empty($files['file']) || empty($files['file']['tmp_name'])) {
            $log('FAIL: 파일 없음. files: ' . json_encode($files));
            return new \WP_Error('no_file', '파일이 없습니다.', ['status' => 400]);
        }

        $file = $files['file'];
        $log("파일명: {$file['name']}, 크기: {$file['size']}, type: {$file['type']}, tmp: {$file['tmp_name']}, error: {$file['error']}");

        // PHP 업로드 에러 코드 확인
        if ($file['error'] !== UPLOAD_ERR_OK) {
            $upload_errors = [
                UPLOAD_ERR_INI_SIZE   => 'php.ini upload_max_filesize 초과',
                UPLOAD_ERR_FORM_SIZE  => 'form MAX_FILE_SIZE 초과',
                UPLOAD_ERR_PARTIAL    => '파일 일부만 업로드됨',
                UPLOAD_ERR_NO_FILE    => '파일 없음',
                UPLOAD_ERR_NO_TMP_DIR => 'tmp 디렉터리 없음',
                UPLOAD_ERR_CANT_WRITE => '디스크 쓰기 실패',
                UPLOAD_ERR_EXTENSION  => 'PHP 확장이 업로드 중단',
            ];
            $err_msg = $upload_errors[$file['error']] ?? "알 수 없는 오류 코드: {$file['error']}";
            $log("FAIL: PHP 업로드 에러 - $err_msg");
            return new \WP_Error('php_upload_error', $err_msg, ['status' => 500]);
        }

        // MIME 검증
        $allowed   = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        $real_mime = function_exists('mime_content_type') ? mime_content_type($file['tmp_name']) : $file['type'];
        $log("real_mime: $real_mime");

        if (!in_array($real_mime, $allowed, true)) {
            $log("FAIL: 허용되지 않는 MIME - $real_mime");
            return new \WP_Error('invalid_type', '이미지 파일만 업로드 가능합니다.', ['status' => 400]);
        }

        // ── 업로드 디렉터리 확인 ──
        wp_set_current_user($user->ID);
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
        require_once ABSPATH . 'wp-admin/includes/image.php';

        $upload_dir = wp_upload_dir();
        $log("upload_dir: {$upload_dir['path']}, error: " . ($upload_dir['error'] ?: 'none'));

        if (!empty($upload_dir['error'])) {
            return new \WP_Error('upload_dir', '업로드 디렉터리 오류: ' . $upload_dir['error'], ['status' => 500]);
        }

        // ── 파일 이동 ──
        $original_name = sanitize_file_name($file['name'] ?: 'image.jpg');
        $filename      = wp_unique_filename($upload_dir['path'], $original_name);
        $dest          = $upload_dir['path'] . '/' . $filename;
        $log("이동 대상: $dest");

        $moved = @move_uploaded_file($file['tmp_name'], $dest);
        $log("move_uploaded_file 결과: " . ($moved ? 'OK' : 'FAIL'));

        if (!$moved) {
            $moved = @copy($file['tmp_name'], $dest);
            $log("copy 폴백 결과: " . ($moved ? 'OK' : 'FAIL'));
        }

        if (!$moved) {
            $log("FAIL: 파일 이동/복사 모두 실패. tmp={$file['tmp_name']}, dest=$dest");
            return new \WP_Error('move_failed', '파일 저장에 실패했습니다.', ['status' => 500]);
        }

        @chmod($dest, 0644);

        // ── DB 등록 ──
        $attachment = [
            'post_mime_type' => $real_mime,
            'post_title'     => preg_replace('/\.[^.]+$/', '', $filename),
            'post_content'   => '',
            'post_status'    => 'inherit',
            'post_author'    => $user->ID,
        ];

        $log('wp_insert_attachment 시작');
        $attachment_id = wp_insert_attachment($attachment, $dest, 0, true);

        if (is_wp_error($attachment_id)) {
            $log('FAIL: wp_insert_attachment - ' . $attachment_id->get_error_message());
            return new \WP_Error('attach_failed', $attachment_id->get_error_message(), ['status' => 500]);
        }

        // 👇 [추가된 부분 1] 업로드된 이미지가 채팅 이미지임을 알리는 꼬리표 추가
        update_post_meta($attachment_id, '_wprc_chat_image', '1');
        // 👆 [추가된 부분 끝]

        $log("attachment_id: $attachment_id");

        $source_url = wp_get_attachment_url($attachment_id);
        $log("source_url: $source_url");

        if (!$source_url) {
            $log('FAIL: URL 생성 실패');
            return new \WP_Error('url_failed', 'URL 생성에 실패했습니다.', ['status' => 500]);
        }

        $log('=== 업로드 성공 ===');

        return rest_ensure_response([
            'source_url' => $source_url,
            'id'         => $attachment_id,
        ]);
    }

    public function render($atts) {
        $atts = shortcode_atts([
            'height' => '700',
        ], $atts, 'realtime_chat');

        $is_logged_in  = is_user_logged_in();
        $allow_guests  = get_option('wprc_allow_guests', true);
        $height        = intval($atts['height']);
        $node_url      = rtrim(get_option('wprc_node_server_url', 'https://chat.swn.kr'), '/');

        // ============================================================
        // ✅ 에셋 로드 (폰트어썸 추가)
        // ============================================================
        // 폰트어썸 로드 (아이콘용)
        wp_enqueue_style('font-awesome', 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css');

        // CSS를 직접 <link> 태그로 출력 (wp_head 이후 숏코드 실행 시에도 확실히 로드)
        $chat_css_url = WPRC_PLUGIN_URL . 'assets/css/chat.css?v=' . time();
        echo '<link rel="stylesheet" id="wprc-chat-style-css" href="' . esc_url($chat_css_url) . '" type="text/css" media="all" />';

        wp_enqueue_script(
            'socket-io-client',
            $node_url . '/socket.io/socket.io.js',
            [],
            '4.7.0',
            true
        );

        $is_mobile = wp_is_mobile();

        // PC / 모바일 스크립트 분기 enqueue
        if ( $is_mobile ) {
            wp_enqueue_script(
                'wprc-chat-client-mobile',
                WPRC_PLUGIN_URL . 'assets/js/chat-client-mobile.js',
                ['socket-io-client'],
                time(),
                true
            );
        } else {
            wp_enqueue_script(
                'wprc-chat-client',
                WPRC_PLUGIN_URL . 'assets/js/chat-client-v2.js',
                ['socket-io-client'],
                time(),
                true
            );
        }

        // 현재 사용자 정보 가져오기
        $current_user = wp_get_current_user();
        $token = '';
        $avatar_url = '';
        $display_name = '게스트';
        
        if ($is_logged_in) {
            $token = $this->jwt_handler->generate_token($current_user);
            $avatar_url = get_avatar_url($current_user->ID, ['size' => 150]);
            $display_name = $current_user->display_name;
        }

        $profile_link = home_url('/profile');

        $wprc_config = [
            'nodeServerUrl' => $node_url,
            'restUrl'       => rest_url('wprc/v1/'),
            'wpMediaUrl'    => rest_url('wp/v2/media'),   // ← 이미지 업로드용
            'nonce'         => wp_create_nonce('wp_rest'),
            'isLoggedIn'    => $is_logged_in,
            'userId'        => $is_logged_in ? $current_user->ID : 0,
            'displayName'   => $is_logged_in ? $current_user->display_name : '게스트',
            'avatarUrl'     => $is_logged_in ? get_avatar_url($current_user->ID) : '',
            'token'         => $token,
            'allowGuests'   => (bool) $allow_guests,
        ];

        // PC / 모바일 스크립트 모두에 동일한 WPRC_Config 주입
        $localize_handle = $is_mobile ? 'wprc-chat-client-mobile' : 'wprc-chat-client';
        wp_localize_script( $localize_handle, 'WPRC_Config', $wprc_config );

        ob_start();
        ?>
        <?php if (!$is_mobile): ?>
        <div id="wprc-chat-app" data-height="<?php echo $height; ?>" style="min-height:200px;">

            <div id="wprc-connection-status" style="padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px;margin-bottom:12px;font-size:13px;display:none;">
                ⏳ 채팅 서버에 연결 중...
            </div>

            <?php if (!$is_logged_in && !$allow_guests): ?>
                <div class="wprc-login-required">
                    <div class="wprc-login-box">
                        <h3>로그인이 필요합니다</h3>
                        <p>채팅에 참여하려면 먼저 로그인해주세요.</p>
                        <a href="<?php echo wp_login_url(get_permalink()); ?>" class="wprc-btn wprc-btn-primary">로그인</a>
                    </div>
                </div>

            <?php elseif (!$is_logged_in && $allow_guests): ?>
                <div id="wprc-guest-form" class="wprc-guest-form">
                    <div class="wprc-login-box">
                        <h3>채팅 참여</h3>
                        <p>닉네임을 입력하고 채팅에 참여하세요.</p>
                        <div class="wprc-form-group">
                            <input type="text" id="wprc-guest-nickname" placeholder="닉네임 (최대 20자)"
                                   maxlength="20" autocomplete="off" />
                        </div>
                        <button type="button" id="wprc-guest-join" class="wprc-btn wprc-btn-primary">참여하기</button>
                        <p class="wprc-note">또는 <a href="<?php echo wp_login_url(get_permalink()); ?>">로그인</a>하여 참여</p>
                    </div>
                </div>
            <?php endif; ?>

            <div id="wprc-main" class="wprc-main wprc-modern-ui" style="display:none; height:<?php echo $height; ?>px;">
                
                <aside id="wprc-sidebar" class="wprc-sidebar wprc-left-sidebar">
                    <div class="wprc-sidebar-header">
                        <h2 style="margin:0; font-size:24px;">채팅</h2>
                        <button id="wprc-create-room" class="wprc-btn-light">+ 새 채팅방</button>
                    </div>
                    <div class="wprc-search-bar" style="margin-bottom: 20px;">
                        <input type="text" placeholder="메시지 검색">
                    </div>
                    <div class="wprc-tabs" style="margin-bottom:15px; border-bottom:1px solid #eee;">
                        <button class="wprc-tab active" data-tab="rooms">채팅방</button>
                        <button class="wprc-tab" data-tab="friends">접속자</button>
                        <button class="wprc-tab" data-tab="settings">설정</button>
                    </div>

                    <div id="wprc-tab-rooms" class="wprc-tab-content active">
                        <ul id="wprc-room-list" class="wprc-list"></ul>
                    </div>

                    <div id="wprc-tab-friends" class="wprc-tab-content">
                        <div class="wprc-online-count" style="font-size:12px; color:#666; margin-bottom:10px;">
                            접속자: <span id="wprc-online-count">0</span>명
                        </div>
                        <ul id="wprc-user-list" class="wprc-list"></ul>
                    </div>

                    <div id="wprc-tab-settings" class="wprc-tab-content">
                        <div class="wprc-settings-panel">
                            <div class="wprc-form-group">
                                <label>표시 닉네임</label>
                                <input type="text" id="wprc-setting-nickname" maxlength="20" style="width:100%; margin-bottom:5px;" />
                                <button id="wprc-save-nickname" class="wprc-btn wprc-btn-sm" style="width:100%;">변경</button>
                            </div>
                            <div class="wprc-form-group" style="margin-top:15px;">
                                <label class="wprc-toggle">
                                    <input type="checkbox" id="wprc-setting-sound" checked />
                                    <span>새 메시지 알림음</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </aside>

                <main id="wprc-chat-area" class="wprc-chat-area wprc-center-panel">
                    <div id="wprc-no-room" class="wprc-no-room">
                        <div class="wprc-no-room-inner">
                            <h3>채팅을 시작하세요</h3>
                            <p>왼쪽 목록에서 채팅방을 선택하거나 새 방을 만들어보세요.</p>
                        </div>
                    </div>

                    <div id="wprc-chat-header" class="wprc-chat-header" style="display:none;">
                        <div class="wprc-chat-header-info">
                            <h4 id="wprc-current-room-name" style="margin:0; font-size:18px;"></h4>
                            <span id="wprc-current-room-users" class="wprc-room-user-count" style="color:#666; font-size:12px; margin-left:10px;"></span>
                        </div>
                        <div class="wprc-chat-header-actions">
                            <button id="wprc-info-toggle" class="btn-info-toggle" title="정보 보기"><i class="fas fa-info"></i></button>
                        </div>
                    </div>

                    <div id="wprc-messages" class="wprc-messages">
                        <div class="wprc-secure-notice">
                            메시지는 완전한 암호화로 서버에 저장하지 않습니다. 세션 스토리지 기술을 적용하여 사용자가 페이지에서 머무르는 동안만 데이터를 저장합니다.
                        </div>
                    </div>

                    <div id="wprc-input-area" class="wprc-input-area" style="display:none;">
                        <div class="wprc-typing-indicator" id="wprc-typing"></div>
                        <div class="wprc-input-row">
                            <input type="text" id="wprc-message-input" placeholder="메시지를 입력하세요..." autocomplete="off" maxlength="2000" />
                            <button id="wprc-send-btn">전송</button>
                        </div>
                    </div>
                </main>

                <aside id="wprc-right-sidebar" class="wprc-right-panel" style="display:none;">
                    <div class="wprc-user-profile-large">
                        <?php if($avatar_url): ?>
                            <img id="wprc-right-avatar" src="<?php echo esc_url($avatar_url); ?>" class="avatar-large" style="object-fit:cover;">
                        <?php else: ?>
                            <div id="wprc-right-avatar" class="avatar-large" style="display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:40px;">
                                <i class="fas fa-user"></i>
                            </div>
                        <?php endif; ?>
                        
                        <h3 id="wprc-right-room-name-display"><?php echo esc_html($display_name); ?></h3>
                    </div>
                    
                    <div class="wprc-action-buttons">
                        <div class="action-item">
                            <a href="<?php echo esc_url($profile_link); ?>" class="icon-btn" target="_blank">
                                <i class="fas fa-user"></i>
                            </a>
                            <span>프로필</span>
                        </div>
                        <div class="action-item">
                            <button class="icon-btn" id="wprc-mute-btn">
                                <i class="fas fa-bell-slash"></i>
                            </button>
                            <span>알림 해제</span>
                        </div>
                        <div class="action-item">
                            <button class="icon-btn">
                                <i class="fas fa-search"></i>
                            </button>
                            <span>검색</span>
                        </div>
                    </div>
                    
                    <button id="wprc-leave-room" class="btn-leave-chat">채팅 나가기</button>
                </aside>

            </div>

            <div id="wprc-modal-create-room" class="wprc-modal" style="display:none;">
                <div class="wprc-modal-content">
                    <h3>새 채팅방 만들기</h3>
                    <div class="wprc-form-group">
                        <label>채팅방 이름</label>
                        <input type="text" id="wprc-new-room-name" placeholder="채팅방 이름" maxlength="50" />
                    </div>
                    <div class="wprc-form-group">
                        <label>유형</label>
                        <select id="wprc-new-room-type">
                            <option value="public">공개 채팅방</option>
                            <option value="private">비공개 채팅방</option>
                        </select>
                    </div>
                    <div class="wprc-modal-actions">
                        <button id="wprc-confirm-create-room" class="wprc-btn wprc-btn-primary">만들기</button>
                        <button class="wprc-btn wprc-modal-close">취소</button>
                    </div>
                </div>
            </div>
        </div>


        <?php endif; ?>
        <?php if ($is_mobile): ?>
        <div id="wprc-chat-app" class="<?php echo $is_mobile ? 'wprc-is-mobile' : 'wprc-is-pc'; ?>" data-height="<?php echo $height; ?>">

            <div id="wprc-connection-status" style="display:none;"></div>

            <?php if ( $is_mobile ) : ?>
                <div class="wprc-mobile-wrapper">

                    <header class="wprc-mobile-header">
                        <div id="wprc-mob-header-friends" class="wprc-mob-tab-header active">
                            <h2>친구</h2>
                        </div>
                        <div id="wprc-mob-header-rooms" class="wprc-mob-tab-header">
                            <h2>채팅</h2>
                            <button id="wprc-mobile-action" class="wprc-mob-new-room-btn">
                                <i class="fas fa-plus"></i> 새 채팅방
                            </button>
                        </div>
                        <div id="wprc-mob-header-settings" class="wprc-mob-tab-header">
                            <h2>설정</h2>
                        </div>
                    </header>

                    <main id="wprc-mobile-main">

                        <div id="wprc-mob-tab-friends" class="wprc-mobile-tab-content active">
                            <div class="wprc-mob-my-profile">
                                <?php if ( $avatar_url ) : ?>
                                    <img src="<?php echo esc_url( $avatar_url ); ?>" class="wprc-mob-my-avatar">
                                <?php else : ?>
                                    <div class="wprc-mob-my-avatar wprc-mob-avatar-placeholder">
                                        <i class="fas fa-user"></i>
                                    </div>
                                <?php endif; ?>
                                <div class="wprc-mob-my-profile-info">
                                    <span class="wprc-mob-my-name"><?php echo esc_html( $display_name ); ?></span>
                                    <span class="wprc-mob-my-status" id="wprc-mob-my-status-display">상태 메시지를 입력하세요</span>
                                </div>
                            </div>
                            <div class="wprc-mob-sort-bar">
                                <span>친구 <strong id="wprc-online-count-mob">0</strong>명</span>
                                <span class="wprc-mob-sort-options">가나다순 · 업데이트순</span>
                            </div>
                            <ul id="wprc-user-list-mob" class="wprc-mobile-list"></ul>
                        </div>

                        <div id="wprc-mob-tab-rooms" class="wprc-mobile-tab-content">
                            <ul id="wprc-room-list-mob" class="wprc-mobile-list"></ul>
                        </div>

                        <div id="wprc-mob-tab-settings" class="wprc-mobile-tab-content">
                            <div class="wprc-mob-settings">
                                <div class="wprc-mob-setting-row">
                                    <label class="wprc-mob-setting-label">표시 닉네임</label>
                                    <div class="wprc-mob-setting-control">
                                        <input type="text" id="wprc-setting-nickname-mob"
                                               value="<?php echo esc_attr( $display_name ); ?>"
                                               maxlength="20" placeholder="닉네임">
                                        <button id="wprc-save-nickname-mob" class="wprc-mob-btn-change">변경</button>
                                    </div>
                                </div>
                                <div class="wprc-mob-setting-row">
                                    <label class="wprc-mob-setting-label">상태 메시지</label>
                                    <div class="wprc-mob-setting-control">
                                        <input type="text" id="wprc-setting-status-mob"
                                               maxlength="60" placeholder="상태 메시지를 입력하세요">
                                        <button id="wprc-save-status-mob" class="wprc-mob-btn-change">변경</button>
                                    </div>
                                    <p class="wprc-mob-setting-desc" id="wprc-status-preview">
                                        현재: <em>없음</em>
                                    </p>
                                </div>
                                <div class="wprc-mob-setting-row wprc-mob-setting-row--between">
                                    <div>
                                        <label class="wprc-mob-setting-label">알림음</label>
                                        <p class="wprc-mob-setting-desc">새 메시지 알림음</p>
                                    </div>
                                    <label class="wprc-mob-toggle">
                                        <input type="checkbox" id="wprc-setting-sound-mob" checked>
                                        <span class="wprc-mob-toggle-track"></span>
                                    </label>
                                </div>
                                <div class="wprc-mob-setting-row wprc-mob-setting-row--block">
                                    <label class="wprc-mob-setting-label">보안 안내</label>
                                    <p class="wprc-mob-setting-desc">
                                        모든 대화 내용은 서버에 저장되지 않습니다.<br>
                                        만약 페이지를 나가시면 대화 기록이 완전히 사라지니 중요한 대화는 미리 백업(캡처)해 두세요.
                                    </p>
                                </div>
                            </div>
                        </div>

                    </main>

                    <nav class="wprc-mobile-nav">
                        <button class="wprc-nav-item active" data-tab="friends">
                            <i class="fas fa-user"></i><span>친구</span>
                        </button>
                        <button class="wprc-nav-item" data-tab="rooms">
                            <i class="fas fa-comment"></i><span>채팅</span>
                        </button>
                        <button class="wprc-nav-item" data-tab="settings">
                            <i class="fas fa-ellipsis-h"></i><span>더보기</span>
                        </button>
                    </nav>

                    <div id="wprc-mobile-chat-view" class="wprc-mobile-overlay">
                        <header class="wprc-mobile-chat-header">
                            <button id="wprc-mobile-back" class="wprc-icon-btn"><i class="fas fa-arrow-left"></i></button>
                            <h2 id="wprc-mobile-chat-name">채팅방</h2>
                            <button id="wprc-mobile-info" class="wprc-icon-btn"><i class="fas fa-bars"></i></button>
                        </header>

                        <div id="wprc-messages-mob" class="wprc-messages-mobile-container"></div>

                        <div class="wprc-mobile-input-area">
                            <div id="wprc-mob-img-preview" class="wprc-mob-img-preview" style="display:none;">
                                <div class="wprc-mob-img-preview-inner">
                                    <img id="wprc-mob-img-preview-img" src="" alt="미리보기">
                                    <button id="wprc-mob-img-cancel" class="wprc-mob-img-cancel" aria-label="취소">
                                        <i class="fas fa-times"></i>
                                    </button>
                                </div>
                            </div>
                            <div class="wprc-mobile-input-row">
                                <input type="file" id="wprc-mob-file-input"
                                       accept="image/jpeg,image/png,image/gif,image/webp" style="display:none;">
                                <button id="wprc-mob-attach-btn" class="wprc-mob-attach-btn" aria-label="사진 첨부">
                                    <i class="fas fa-image"></i>
                                </button>
                                <input type="text" id="wprc-message-input-mob"
                                       placeholder="메시지를 입력하세요 (enter 시 전송)"
                                       autocomplete="off" maxlength="2000">
                                <button id="wprc-send-btn-mob" aria-label="전송">
                                    <i class="fas fa-paper-plane"></i>
                                </button>
                            </div>
                        </div>
                    </div>

                </div>

            <?php else : ?>
                <div class="wprc-main wprc-modern-ui">
                    </div>
            <?php endif; ?>

        </div>
        <?php endif; // is_mobile ?>

        <script>
        (function() {

            // 🚀 [핵심 추가] 자바스크립트가 로드된 후 사용자 정보를 강제로 한 번 더 입힙니다.
            document.addEventListener('DOMContentLoaded', function() {
                const config = window.WPRC_Config;
                if (config && config.isLoggedIn) {
                    const nameDisplay = document.getElementById('wprc-right-room-name-display');
                    if (nameDisplay) {
                        nameDisplay.textContent = config.displayName;
                    }
                }
            });

            var statusEl = document.getElementById('wprc-connection-status');
            setTimeout(function() {
                if (typeof io === 'undefined') {
                    if (statusEl) {
                        statusEl.style.display = 'block';
                        statusEl.style.background = '#f8d7da';
                        statusEl.style.borderColor = '#f5c6cb';
                        statusEl.style.color = '#721c24';
                        statusEl.innerHTML = '❌ 채팅 서버에 연결할 수 없습니다.';
                    }
                }
            }, 3000);
        })();
        </script>
        <?php
        return ob_get_clean();
    }

    // 👇 [추가된 부분 2] 1시간 지난 채팅 이미지 자동 삭제 (크론 작업)
    public function cleanup_temp_files() {
        // 1시간(3600초) 전의 시간 계산
        $time_ago = date('Y-m-d H:i:s', current_time('timestamp') - 3600);

        // 삭제할 조건 설정
        $args = [
            'post_type'      => 'attachment',
            'post_status'    => 'any',
            'posts_per_page' => -1, // 조건에 맞는 것 전부
            'fields'         => 'ids', // 메모리 절약을 위해 ID만 가져옴
            'meta_query'     => [
                [
                    'key'     => '_wprc_chat_image', // 우리가 달아둔 채팅 이미지 꼬리표
                    'value'   => '1',
                    'compare' => '='
                ]
            ],
            'date_query'     => [
                [
                    'before'    => $time_ago, // 1시간 이전 파일만
                    'inclusive' => true,
                ]
            ],
        ];

        // 조건에 맞는 첨부파일 ID 가져오기
        $expired_attachments = get_posts($args);

        if (!empty($expired_attachments)) {
            foreach ($expired_attachments as $attachment_id) {
                // 두 번째 파라미터를 true로 설정하여 휴지통을 거치지 않고 DB와 실제 파일을 즉시 영구 삭제
                wp_delete_attachment($attachment_id, true);
            }
            error_log('[WPRC-CRON] 1시간이 지난 채팅 이미지 ' . count($expired_attachments) . '개를 성공적으로 삭제했습니다.');
        } else {
            error_log('[WPRC-CRON] 삭제할 오래된 채팅 이미지가 없습니다.');
        }
    }
    // 👆 [추가된 부분 2 끝]
}