#include <iostream>
#include <vector>
#include <string>
#include <thread>
#include <chrono>
#include <cstring>
#include <atomic>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <mutex>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
#else
    #include <sys/socket.h>
    #include <netinet/in.h>
    #include <arpa/inet.h>
    #include <unistd.h>
#endif

#pragma pack(push, 1)
struct YVToYLSPacket {
    uint8_t yls_index;
    uint8_t command;
    struct {
        uint8_t sign;
        uint8_t value;
    } angles[4];
    uint8_t pyro_mask;
    uint8_t reserved[141];
};

struct YLSToYVPacket {
    uint8_t yls_index;
    uint8_t result;
    struct {
        uint8_t sign;
        uint8_t value;
    } angles[48];
    uint8_t yaz[192];
    uint8_t yvp[648];
    uint8_t pyro[12];
    uint8_t ya_lk[192];
    uint8_t reserved[7050];
};
#pragma pack(pop)

inline uint8_t calculate_crc8(const uint8_t* data, size_t len) {
    uint8_t crc = 0;
    for (size_t i = 0; i < len; ++i) {
        crc ^= data[i];
    }
    return crc;
}

enum CommandId {
    START = 0x01,
    STOP = 0x02,
    TEST = 0x03,
    UPLOAD = 0x04,
    SET_PAYLOAD = 0x05,
    SET_TARGET_CONFIG = 0x06
};

struct YavConfig {
    std::string operatorIp = "192.168.17.1";
    int operatorLocalPort = 300;
    int operatorRemotePort = 400;
    std::string yavIp = "192.168.17.246";
    std::string yalsIp = "192.168.17.230";
    int yalsLocalPort = 200;
    int yalsRemotePort = 101;
    int telemetryPort = 5006;
    bool autostart = false;
    std::string asnIp = "127.0.0.1";
    int asnLocalPort = 103;
    int asnRemotePort = 102;
    int asnPeriod = 2000;
};

class YavService {
public:
    YavService(const YavConfig& config) 
        : config_(config), 
          yals_ip_(config.yalsIp), 
          yals_port_(config.yalsRemotePort), 
          running_(false),
          asn_test_active_(false),
          last_operator_ip_(config.operatorIp),
          last_operator_port_(config.operatorRemotePort) {
        
        memset(&current_yav_, 0, sizeof(current_yav_));
        current_yav_.yls_index = 1;
        current_yav_.command = 1;

        cmd_socket_ = -1;
        yals_socket_ = -1;
        tel_socket_ = -1;
        asn_socket_ = -1;
    }

    ~YavService() {
        stop();
        asn_test_active_.store(false);
        if (cmd_socket_ >= 0) close_socket(cmd_socket_);
        if (yals_socket_ >= 0) close_socket(yals_socket_);
        if (tel_socket_ >= 0) close_socket(tel_socket_);
        if (asn_socket_ >= 0) close_socket(asn_socket_);
    }

    bool init() {
#ifdef _WIN32
        WSADATA wsaData;
        if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) return false;
#endif
        cmd_socket_ = socket(AF_INET, SOCK_DGRAM, 0);
        yals_socket_ = socket(AF_INET, SOCK_DGRAM, 0);
        tel_socket_ = socket(AF_INET, SOCK_DGRAM, 0);
        
        if (cmd_socket_ < 0 || yals_socket_ < 0 || tel_socket_ < 0) return false;

        asn_socket_ = socket(AF_INET, SOCK_DGRAM, 0);
        if (asn_socket_ < 0) return false;

        sockaddr_in cmd_addr;
        memset(&cmd_addr, 0, sizeof(cmd_addr));
        cmd_addr.sin_family = AF_INET;
        cmd_addr.sin_addr.s_addr = INADDR_ANY;
        cmd_addr.sin_port = htons(config_.operatorLocalPort);

        if (bind(cmd_socket_, (struct sockaddr*)&cmd_addr, sizeof(cmd_addr)) < 0) {
            std::cerr << "Failed to bind command socket to port " << config_.operatorLocalPort << std::endl;
            return false;
        }

        sockaddr_in yals_local_addr;
        memset(&yals_local_addr, 0, sizeof(yals_local_addr));
        yals_local_addr.sin_family = AF_INET;
        yals_local_addr.sin_addr.s_addr = INADDR_ANY;
        yals_local_addr.sin_port = htons(config_.yalsLocalPort);

        if (bind(yals_socket_, (struct sockaddr*)&yals_local_addr, sizeof(yals_local_addr)) < 0) {
            // std::cerr << "Warning: Failed to bind YALS socket to port " << config_.yalsLocalPort << ". Will use random port." << std::endl;
        }

        sockaddr_in asn_local_addr;
        memset(&asn_local_addr, 0, sizeof(asn_local_addr));
        asn_local_addr.sin_family = AF_INET;
        asn_local_addr.sin_addr.s_addr = INADDR_ANY;
        asn_local_addr.sin_port = htons(config_.asnLocalPort);

        if (bind(asn_socket_, (struct sockaddr*)&asn_local_addr, sizeof(asn_local_addr)) < 0) {
            std::cerr << "Failed to bind ASN socket to port " << config_.asnLocalPort << std::endl;
            return false;
        }

        std::cout << "TS БЦВМ Service Config:" << std::endl; 
        std::string opIp = config_.operatorIp.empty() ? "0.0.0.0" : config_.operatorIp;
        std::cout << "  " << opIp << ":" << config_.operatorRemotePort << " -> " << config_.yavIp << ":" << config_.operatorLocalPort << " [ОПЕРАТОР -> БЦВМ]" << std::endl;
        std::cout << "  " << config_.yavIp << ":" << config_.yalsLocalPort << " -> " << config_.yalsIp << ":" << config_.yalsRemotePort << " [БЦВМ -> ЯЛС]" << std::endl;
        return true;
    }

    void run() {
        if (config_.autostart) {
            std::cout << "Autostart enabled. Starting continuous exchange..." << std::endl;
            start();
        }
        command_loop();
    }

private:
    void command_loop() {
        uint8_t buffer[65535];
        sockaddr_in client_addr;

        while (true) {
            fd_set read_fds;
            FD_ZERO(&read_fds);

            int max_fd = -1;
            if (cmd_socket_ >= 0) {
                FD_SET(cmd_socket_, &read_fds);
                if (cmd_socket_ > max_fd) max_fd = cmd_socket_;
            }
            if (asn_socket_ >= 0) {
                FD_SET(asn_socket_, &read_fds);
                if (asn_socket_ > max_fd) max_fd = asn_socket_;
            }

            struct timeval tv;
            tv.tv_sec = 0;
            tv.tv_usec = 20000; // 20ms timeout on select to remain responsive and lightweight

            int ret = select(max_fd + 1, &read_fds, NULL, NULL, &tv);
            if (ret > 0) {
                if (cmd_socket_ >= 0 && FD_ISSET(cmd_socket_, &read_fds)) {
                    socklen_t client_len = sizeof(client_addr);
                    int n = recvfrom(cmd_socket_, (char*)buffer, sizeof(buffer), 0, (struct sockaddr*)&client_addr, &client_len);
                    if (n > 0) {
                        handle_command(buffer, n, client_addr);
                    }
                }

                if (asn_socket_ >= 0 && FD_ISSET(asn_socket_, &read_fds)) {
                    handle_asn_incoming();
                }
            }
        }
    }

    sockaddr_in get_operator_addr(const sockaddr_in& source_addr) {
        sockaddr_in target = source_addr;
        return target;
    }

    void handle_command(uint8_t* data, int len, sockaddr_in client_addr) {
        if (len < 1) return;

        char client_ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);
        int client_port = ntohs(client_addr.sin_port);

        last_operator_ip_ = client_ip;
        last_operator_port_ = client_port;

        if (config_.operatorRemotePort && client_port != config_.operatorRemotePort) {
            std::stringstream ss_ignore;
            ss_ignore << "ИГНОР: Пакет 0x" << std::hex << std::uppercase << (int)data[0] 
                      << " проигнорирован (несовпадение порта отправителя)";
            
            send_telemetry(ss_ignore.str(), "WARNING",
                { "НЕИЗВЕСТНЫЙ", client_ip, client_port },
                { "БЦВМ", config_.yavIp, get_actual_port(cmd_socket_) }
            );
            return;
        }

        CommandId cmd;
        uint16_t parsed_period = 0;

        if (len == 8 && data[0] == 0xAA) {
            uint8_t crc = calculate_crc8(data, 7);
            if (crc != data[7]) {
                std::cerr << "БЦВМ: Ошибка CRC8 пакета от Оператора: " << (int)data[7] << " vs " << (int)crc << std::endl;
                return;
            }
            cmd = static_cast<CommandId>(data[1]);
            parsed_period = (data[2] << 8) | data[3];
            if (parsed_period > 0) {
                config_.asnPeriod = parsed_period;
            }
        } else {
            cmd = static_cast<CommandId>(data[0]);
        }

        uint16_t active_period = (parsed_period > 0) ? parsed_period : config_.asnPeriod;
        double freq = 1000.0 / active_period;
        std::stringstream ss_tel;
        if (cmd == START) {
            if (parsed_period == 0) {
                ss_tel << "БЦВМ: Получена команда [НАЧАТЬ ДВИЖЕНИЕ] от ОПЕРАТОРА. Период/частота в пакете: 0 (текущий сохранен: " << active_period << " мс, " << std::fixed << std::setprecision(1) << freq << " Гц)";
            } else {
                ss_tel << "БЦВМ: Получена команда [НАЧАТЬ ДВИЖЕНИЕ] от ОПЕРАТОРА. Заданный период: " << parsed_period << " мс (частота: " << std::fixed << std::setprecision(1) << freq << " Гц)";
            }
        } else if (cmd == STOP) {
            ss_tel << "БЦВМ: Получена команда [ОСТАНОВИТЬ ДВИЖЕНИЕ] от ОПЕРАТОРА";
        } else if (cmd == TEST) {
            if (parsed_period == 0) {
                ss_tel << "БЦВМ: Получена команда [ТЕСТ СВЯЗИ] от ОПЕРАТОРА (период/частота в пакете: 0, текущий сохранен: " << active_period << " мс, " << std::fixed << std::setprecision(1) << freq << " Гц)";
            } else {
                ss_tel << "БЦВМ: Получена команда [ТЕСТ СВЯЗИ] от ОПЕРАТОРА (заданный период: " << parsed_period << " мс, частота: " << std::fixed << std::setprecision(1) << freq << " Гц)";
            }
        } else {
            ss_tel << "БЦВМ: Получена команда 0x" << std::hex << std::uppercase << (int)cmd << " от ОПЕРАТОРА";
        }
        
        if (cmd != STOP && cmd != TEST) {
            send_telemetry(ss_tel.str(), "SUCCESS", 
                { "БЦВМ", config_.yavIp, get_actual_port(cmd_socket_) },
                { "ОПЕРАТОР", client_ip, client_port }, 
                data, len
            );
        }

        sockaddr_in op_addr = get_operator_addr(client_addr);
        
        // Send (cmd + 1) confirmation to operator
        {
            uint8_t ack_val = static_cast<uint8_t>(cmd) + 1;
            if (cmd == TEST) {
                uint8_t ack_pkt[8] = { ack_val, 0, 0, 0, 0, 0, 0, 0 };
                ack_pkt[7] = calculate_crc8(ack_pkt, 7);
                sendto(cmd_socket_, (char*)ack_pkt, 8, 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
                
                std::stringstream ss_ack;
                ss_ack << "БЦВМ: Отправлено подтверждение команды (0x" << std::hex << std::uppercase << (int)ack_val << ")";
                send_telemetry(ss_ack.str(), "SUCCESS",
                    { "БЦВМ", config_.yavIp, get_actual_port(cmd_socket_) },
                    { "ОПЕРАТОР", client_ip, client_port },
                    ack_pkt, 8
                );
            } else {
                sendto(cmd_socket_, (char*)&ack_val, 1, 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
                
                std::stringstream ss_ack;
                ss_ack << "БЦВМ: Отправлено подтверждение команды (0x" << std::hex << std::uppercase << (int)ack_val << ")";
                send_telemetry(ss_ack.str(), "SUCCESS",
                    { "БЦВМ", config_.yavIp, get_actual_port(cmd_socket_) },
                    { "ОПЕРАТОР", client_ip, client_port },
                    &ack_val, 1
                );
            }
        }

        switch (cmd) {
            case START:
                std::cout << client_ip << ":" << client_port << " -> " << config_.yavIp << ":" << config_.operatorLocalPort << " [КОМАНДА: ПУСК] [1 байт]" << std::endl;
                start();
                break;
            case STOP:
                std::cout << client_ip << ":" << client_port << " -> " << config_.yavIp << ":" << config_.operatorLocalPort << " [КОМАНДА: СТОП] [1 байт]" << std::endl;
                stop();
                break;
            case TEST:
                std::cout << client_ip << ":" << client_port << " -> " << config_.yavIp << ":" << config_.operatorLocalPort << " [КОМАНДА: ТЕСТ СВЯЗИ] [1 байт]" << std::endl;
                test_connection(client_addr);
                break;
            case UPLOAD:
                std::cout << client_ip << ":" << client_port << " -> " << config_.yavIp << ":" << config_.operatorLocalPort << " [КОМАНДА: ЗАГРУЗКА] [" << len << " байт]" << std::endl;
                handle_upload(data + 1, len - 1, client_addr);
                break;
            case SET_PAYLOAD:
                if (len >= (1 + 4 * 2 + 1 + 1)) { 
                    for(int i=0; i<4; ++i) {
                        current_yav_.angles[i].sign = data[1 + i*2];
                        current_yav_.angles[i].value = data[2 + i*2];
                    }
                    current_yav_.pyro_mask = data[9];
                    current_yav_.command = data[10];
                    std::cout << client_ip << ":" << client_port << " -> " << config_.yavIp << ":" << config_.operatorLocalPort << " [УСТАНОВКА ДАННЫХ: Cmd=" << (int)current_yav_.command << "] [" << len << " байт]" << std::endl;
                }
                break;
            case SET_TARGET_CONFIG:
                if (len >= 7) { 
                    char ip_buf[16];
                    sprintf(ip_buf, "%u.%u.%u.%u", data[1], data[2], data[3], data[4]);
                    yals_ip_ = ip_buf;
                    yals_port_ = (data[5] << 8) | data[6];
                    
                    if (len >= 9) {
                        config_.operatorRemotePort = (data[7] << 8) | data[8];
                    }
                    
                    std::cout << client_ip << ":" << client_port << " -> " << config_.yavIp << ":" << get_actual_port(cmd_socket_) << " [ОБНОВЛЕНИЕ ЦЕЛИ: " << yals_ip_ << ":" << yals_port_ << "] [" << len << " байт]" << std::endl;
                    
                    send_telemetry("БЦВМ: Конфигурация цели обновлена", "INFO",
                        { "БЦВМ", config_.yavIp, get_actual_port(cmd_socket_) },
                        { "ОПЕРАТОР", client_ip, client_port }
                    );
                }
                break;
            default:
                break;
        }
    }

    void handle_upload(uint8_t* data, int len, sockaddr_in client_addr) {
        // No upload confirmation sent to operator anymore
    }

    void test_connection(sockaddr_in client_addr) {
        char client_ip[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);
        int client_port = ntohs(client_addr.sin_port);

        last_operator_ip_ = client_ip;
        last_operator_port_ = client_port;

        sockaddr_in op_addr = client_addr; // Use exact client_addr received!

        if (!asn_test_active_.load()) {
            // START ASN connection test AND run regular YALS test
            asn_test_active_.store(true);

            YVToYLSPacket test_pkt;
            memset(&test_pkt, 0, sizeof(test_pkt));
            test_pkt.yls_index = 0x01; 
            test_pkt.command = 0x01;   

            sockaddr_in target_addr;
            memset(&target_addr, 0, sizeof(target_addr));
            target_addr.sin_family = AF_INET;
            target_addr.sin_port = htons(yals_port_);
            inet_pton(AF_INET, yals_ip_.c_str(), &target_addr.sin_addr);

            std::cout << config_.yavIp << ":" << get_actual_port(yals_socket_) << " -> " << yals_ip_ << ":" << yals_port_ << " [СВЯЗЬ: ЗАПР БЦВМ] [152 байт]" << std::endl;
            
            std::stringstream ss_sent;
            ss_sent << "БЦВМ: Пакет отправлен к ЯЛС";
            
            send_telemetry(ss_sent.str(), "INFO",
                { "БЦВМ", config_.yavIp, get_actual_port(yals_socket_) },
                { "ЯЛС", yals_ip_, yals_port_ },
                (uint8_t*)&test_pkt, sizeof(test_pkt)
            );

            sendto(yals_socket_, (char*)&test_pkt, sizeof(test_pkt), 0, (struct sockaddr*)&target_addr, sizeof(target_addr));

            struct timeval tv;
            tv.tv_sec = 2;
            tv.tv_usec = 0;
            setsockopt(yals_socket_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));

            YLSToYVPacket resp_pkt;
            sockaddr_in from_addr;
            socklen_t from_len = sizeof(from_addr);
            int n = recvfrom(yals_socket_, (char*)&resp_pkt, sizeof(resp_pkt), 0, (struct sockaddr*)&from_addr, &from_len);
            
            if (n > 0) {
                char yals_sender_ip[INET_ADDRSTRLEN];
                inet_ntop(AF_INET, &from_addr.sin_addr, yals_sender_ip, INET_ADDRSTRLEN);
                int yals_sender_port = ntohs(from_addr.sin_port);

                std::cout << yals_sender_ip << ":" << yals_sender_port << " -> " << config_.yavIp << ":" << get_actual_port(yals_socket_) << " [ОТВЕТ ЯЛС] [" << n << " байт]" << std::endl;
                std::stringstream ss_recv;
                ss_recv << "ЯЛС: Пакет отправлен к БЦВМ";
                send_telemetry(ss_recv.str(), "SUCCESS",
                    { "ЯЛС", yals_sender_ip, yals_sender_port },
                    { "БЦВМ", config_.yavIp, get_actual_port(yals_socket_) },
                    (uint8_t*)&resp_pkt, n
                );

                // Relay YALS test packets to Operator
                sendto(cmd_socket_, (char*)&test_pkt, sizeof(test_pkt), 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
                std::cout << config_.yavIp << ":" << get_actual_port(cmd_socket_) << " -> " << client_ip << ":" << client_port << " [ПЕРЕСЫЛКА ЗАПРОСА ОПЕРАТОРУ] [152 байт]" << std::endl;

                sendto(cmd_socket_, (char*)&resp_pkt, sizeof(resp_pkt), 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
                std::cout << config_.yavIp << ":" << get_actual_port(cmd_socket_) << " -> " << client_ip << ":" << client_port << " [ПЕРЕСЫЛКА ОТВЕТА ОПЕРАТОРУ] [8192 байт]" << std::endl;

                std::cout << "БЦВМ: Получен пакет 8192 байт от ЯЛС" << std::endl;
                send_telemetry("БЦВМ: Получен пакет 8192 байт от ЯЛС", "INFO", {}, {});
            } else {
                std::cerr << yals_ip_ << ":" << yals_port_ << " -> " << config_.yavIp << ":" << get_actual_port(yals_socket_) << " [СВЯЗЬ: ОШИБКА (ТАЙМАУТ)]" << std::endl;
                send_telemetry("ЯЛС: Ошибка связи (таймаут)", "ERROR",
                    { "ЯЛС", yals_ip_, yals_port_ },
                    { "БЦВМ", config_.yavIp, get_actual_port(yals_socket_) }
                );
            }

            // Now, send SETUP packet to ASN (using the parsed config period from the Operator)
            uint8_t period_H = (config_.asnPeriod >> 8) & 0xFF;
            uint8_t period_L = config_.asnPeriod & 0xFF;
            uint8_t setup_pkt[8] = { 0xAA, 0x01, period_H, period_L, 0, 0, 0, 0 };
            setup_pkt[7] = calculate_crc8(setup_pkt, 7);

            sockaddr_in target_asn_addr;
            memset(&target_asn_addr, 0, sizeof(target_asn_addr));
            target_asn_addr.sin_family = AF_INET;
            target_asn_addr.sin_port = htons(config_.asnRemotePort);
            inet_pton(AF_INET, config_.asnIp.c_str(), &target_asn_addr.sin_addr);

            std::cout << "БЦВМ -> АСН [НАСТРОЙКА] [Период в пакете: " << config_.asnPeriod << " мс]" << std::endl;
            std::stringstream ss_setup;
            ss_setup << "БЦВМ: Отправка пакета [НАСТРОЙКА АСН] (период в пакете: " << config_.asnPeriod << " мс)";
            
            send_telemetry(ss_setup.str(), "INFO",
                { "БЦВМ", config_.yavIp, get_actual_port(asn_socket_) },
                { "АСН", config_.asnIp, config_.asnRemotePort },
                setup_pkt, 8
            );

            // Send to ASN and also duplicate exactly 8 bytes to Operator
            sendto(asn_socket_, (char*)setup_pkt, 8, 0, (struct sockaddr*)&target_asn_addr, sizeof(target_asn_addr));
            sendto(cmd_socket_, (char*)setup_pkt, 8, 0, (struct sockaddr*)&op_addr, sizeof(op_addr));

        } else {
            // STOP active ASN connection test
            uint8_t stop_pkt[8] = { 0xAA, 0x02, 0, 0, 0, 0, 0, 0 };
            stop_pkt[7] = calculate_crc8(stop_pkt, 7);

            sockaddr_in target_asn_addr;
            memset(&target_asn_addr, 0, sizeof(target_asn_addr));
            target_asn_addr.sin_family = AF_INET;
            target_asn_addr.sin_port = htons(config_.asnRemotePort);
            inet_pton(AF_INET, config_.asnIp.c_str(), &target_asn_addr.sin_addr);

            std::cout << "БЦВМ -> АСН [ОСТАНОВКА АСН]" << std::endl;
            std::stringstream ss_asn_stop;
            ss_asn_stop << "БЦВМ: Отправка пакета [ОСТАНОВКА АСН]";
            
            send_telemetry(ss_asn_stop.str(), "INFO",
                { "БЦВМ", config_.yavIp, get_actual_port(asn_socket_) },
                { "АСН", config_.asnIp, config_.asnRemotePort },
                stop_pkt, 8
            );

            // Send to ASN and duplicate exactly 8 bytes to Operator
            sendto(asn_socket_, (char*)stop_pkt, 8, 0, (struct sockaddr*)&target_asn_addr, sizeof(target_asn_addr));
            sendto(cmd_socket_, (char*)stop_pkt, 8, 0, (struct sockaddr*)&op_addr, sizeof(op_addr));

            // Stop background thread & join
            asn_test_active_.store(false);
        }
    }

    void start() {
        if (running_) return;

        // Clean up ASN test if active
        if (asn_test_active_.load()) {
            asn_test_active_.store(false);
        }

        running_ = true;

        // Setup ASN (zero frequency/period per user request)
        uint8_t period_H = 0;
        uint8_t period_L = 0;
        uint8_t setup_pkt[8] = { 0xAA, 0x01, period_H, period_L, 0, 0, 0, 0 };
        setup_pkt[7] = calculate_crc8(setup_pkt, 7);

        sockaddr_in target_asn_addr;
        memset(&target_asn_addr, 0, sizeof(target_asn_addr));
        target_asn_addr.sin_family = AF_INET;
        target_asn_addr.sin_port = htons(config_.asnRemotePort);
        inet_pton(AF_INET, config_.asnIp.c_str(), &target_asn_addr.sin_addr);

        std::cout << "БЦВМ -> АСН [НАСТРОЙКА] [Период в пакете: 0 мс]" << std::endl;
        std::stringstream ss;
        ss << "БЦВМ: Отправка пакета [НАСТРОЙКА АСН] (период в пакете: 0 мс, сохранение текущего на АСН)";
        send_telemetry(ss.str(), "INFO",
            { "БЦВМ", config_.yavIp, config_.asnLocalPort },
            { "АСН", config_.asnIp, config_.asnRemotePort },
            setup_pkt, 8
        );

        sendto(asn_socket_, (char*)setup_pkt, 8, 0, (struct sockaddr*)&target_asn_addr, sizeof(target_asn_addr));
    }

    void stop() {
        bool test_active = asn_test_active_.load();
        if (!running_ && !test_active) return;

        // Clean up ASN test if active
        if (test_active) {
            asn_test_active_.store(false);
        }

        running_ = false;

        // Stop ASN
        uint8_t stop_pkt[8] = { 0xAA, 0x02, 0, 0, 0, 0, 0, 0 };
        stop_pkt[7] = calculate_crc8(stop_pkt, 7);

        sockaddr_in target_asn_addr;
        memset(&target_asn_addr, 0, sizeof(target_asn_addr));
        target_asn_addr.sin_family = AF_INET;
        target_asn_addr.sin_port = htons(config_.asnRemotePort);
        inet_pton(AF_INET, config_.asnIp.c_str(), &target_asn_addr.sin_addr);

        std::cout << "БЦВМ -> АСН [ОСТАНОВКА]" << std::endl;
        std::stringstream ss;
        ss << "БЦВМ: Отправка пакета [ОСТАНОВКА АСН]";
        send_telemetry(ss.str(), "INFO",
            { "БЦВМ", config_.yavIp, config_.asnLocalPort },
            { "АСН", config_.asnIp, config_.asnRemotePort },
            stop_pkt, 8
        );

        sendto(asn_socket_, (char*)stop_pkt, 8, 0, (struct sockaddr*)&target_asn_addr, sizeof(target_asn_addr));

        // Duplicate stopped packet to Operator
        if (!last_operator_ip_.empty() && last_operator_port_ > 0) {
            sockaddr_in op_addr;
            memset(&op_addr, 0, sizeof(op_addr));
            op_addr.sin_family = AF_INET;
            op_addr.sin_port = htons(last_operator_port_);
            inet_pton(AF_INET, last_operator_ip_.c_str(), &op_addr.sin_addr);
            sendto(cmd_socket_, (char*)stop_pkt, 8, 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
        }
    }

    void handle_asn_incoming() {
        uint8_t asn_rx[1024];
        sockaddr_in from_asn_addr;
        socklen_t from_asn_len = sizeof(from_asn_addr);
        int rx_len = recvfrom(asn_socket_, (char*)asn_rx, sizeof(asn_rx), 0, (struct sockaddr*)&from_asn_addr, &from_asn_len);
        if (rx_len > 0) {
            char asn_sender_ip[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &from_asn_addr.sin_addr, asn_sender_ip, INET_ADDRSTRLEN);
            int asn_sender_port = ntohs(from_asn_addr.sin_port);

            if (rx_len == 8) {
                uint8_t received_crc = asn_rx[7];
                uint8_t calculated_crc = calculate_crc8(asn_rx, 7);
                if (received_crc == calculated_crc) {
                    if (asn_rx[0] == 0xBB) {
                        if (running_) {
                            if (asn_rx[1] == 0x00) {
                                uint16_t ts = (asn_rx[2] << 8) | asn_rx[3];

                                std::stringstream ss_log;
                                ss_log << "БЦВМ: Получен такт " << ts << " от АСН";
                                
                                send_telemetry(ss_log.str(), "SUCCESS",
                                    { "", "", 0 },
                                    { "", "", 0 },
                                    asn_rx, 8
                                );

                                do_yals_exchange();
                            }
                        } else if (asn_test_active_) {
                            if (asn_rx[1] == 0x00) {
                                uint16_t ts = (asn_rx[2] << 8) | asn_rx[3];
                                std::stringstream ss;
                                ss << "БЦВМ: Получен такт " << ts << " от АСН";
                                send_telemetry(ss.str(), "SUCCESS",
                                    { "", "", 0 },
                                    { "", "", 0 },
                                    asn_rx, rx_len
                                );
                            } else if (asn_rx[1] == 0x03) {
                                std::stringstream ss;
                                ss << "БЦВМ: Получено подтверждение остановки АСН";
                                send_telemetry(ss.str(), "SUCCESS",
                                    { "", "", 0 },
                                    { "", "", 0 },
                                    asn_rx, rx_len
                                );
                            }

                            // Duplicate the packet to Operator
                            sockaddr_in op_addr;
                            memset(&op_addr, 0, sizeof(op_addr));
                            op_addr.sin_family = AF_INET;
                            op_addr.sin_port = htons(last_operator_port_);
                            inet_pton(AF_INET, last_operator_ip_.c_str(), &op_addr.sin_addr);

                            sendto(cmd_socket_, (char*)asn_rx, 8, 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
                        }
                    }
                } else {
                    send_telemetry("БЦВМ: Получен такт от АСН с неверным CRC", "WARNING",
                        { "АСН", asn_sender_ip, asn_sender_port },
                        { "БЦВМ", config_.yavIp, get_actual_port(asn_socket_) },
                        asn_rx, 8
                    );
                }
            }
        }
    }

    void do_yals_exchange() {
        sockaddr_in target_addr;
        memset(&target_addr, 0, sizeof(target_addr));
        target_addr.sin_family = AF_INET;
        target_addr.sin_port = htons(yals_port_);
        inet_pton(AF_INET, yals_ip_.c_str(), &target_addr.sin_addr);

        struct timeval tv;
        tv.tv_sec = 1;
        tv.tv_usec = 800000; // 1.8s timeout
        setsockopt(yals_socket_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));

        YVToYLSPacket pkt = serialize_packet();

        std::cout << config_.yavIp << ":" << get_actual_port(yals_socket_) << " -> " << yals_ip_ << ":" << yals_port_ << " [ЦИКЛ: ЗАПР БЦВМ] [152 байт]" << std::endl;
        std::stringstream ss;
        ss << "БЦВМ: Пакет отправлен к ЯЛС";
        
        send_telemetry(ss.str(), "INFO",
            { "БЦВМ", config_.yavIp, get_actual_port(yals_socket_) },
            { "ЯЛС", yals_ip_, yals_port_ },
            (uint8_t*)&pkt, sizeof(pkt)
        );

        sendto(yals_socket_, (char*)&pkt, sizeof(pkt), 0, (struct sockaddr*)&target_addr, sizeof(target_addr));

        YLSToYVPacket resp;
        sockaddr_in from_addr;
        socklen_t from_len = sizeof(from_addr);
        int n = recvfrom(yals_socket_, (char*)&resp, sizeof(resp), 0, (struct sockaddr*)&from_addr, &from_len);
        
        if (n > 0) {
            char yals_sender_ip[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &from_addr.sin_addr, yals_sender_ip, INET_ADDRSTRLEN);
            int yals_sender_port = ntohs(from_addr.sin_port);

            std::cout << yals_sender_ip << ":" << yals_sender_port << " -> " << config_.yavIp << ":" << get_actual_port(yals_socket_) << " [ЦИКЛ: ОТВЕТ ЯЛС] [" << n << " байт]" << std::endl;
            std::stringstream ssr;
            ssr << "ЯЛС: Пакет отправлен к БЦВМ";
            send_telemetry(ssr.str(), "SUCCESS",
                { "ЯЛС", yals_sender_ip, yals_sender_port },
                { "БЦВМ", config_.yavIp, get_actual_port(yals_socket_) },
                (uint8_t*)&resp, n
            );

            // Relay feedback to Operator using dynamic last_operator_ip_ and last_operator_port_
            sockaddr_in op_addr;
            memset(&op_addr, 0, sizeof(op_addr));
            op_addr.sin_family = AF_INET;
            op_addr.sin_port = htons(last_operator_port_);
            inet_pton(AF_INET, last_operator_ip_.c_str(), &op_addr.sin_addr);

            sendto(cmd_socket_, (char*)&pkt, sizeof(pkt), 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
            std::cout << config_.yavIp << ":" << get_actual_port(cmd_socket_) << " -> " << last_operator_ip_ << ":" << last_operator_port_ << " [ЦИКЛ: ПЕРЕСЫЛКА ЗАПРОСА ОПЕРАТОРУ] [152 байт]" << std::endl;

            // 2. Data packet 8192
            sendto(cmd_socket_, (char*)&resp, sizeof(resp), 0, (struct sockaddr*)&op_addr, sizeof(op_addr));
            std::cout << config_.yavIp << ":" << get_actual_port(cmd_socket_) << " -> " << last_operator_ip_ << ":" << last_operator_port_ << " [ЦИКЛ: ПЕРЕСЫЛКА ОТВЕТА ОПЕРАТОРУ] [8192 байт]" << std::endl;

            std::cout << "БЦВМ: Получен пакет 8192 байт от ЯЛС" << std::endl;
            send_telemetry("БЦВМ: Получен пакет 8192 байт от ЯЛС", "INFO", {}, {});
        } else {
            send_telemetry("ЯЛС: ОШИБКА ПРИЕМА (ТАЙМАУТ)", "ERROR",
                { "ЯЛС", yals_ip_, yals_port_ },
                { "БЦВМ", config_.yavIp, get_actual_port(yals_socket_) }
            );
        }
    }

    YVToYLSPacket serialize_packet() {
        YVToYLSPacket pkt = current_yav_;
        return pkt;
    }

    struct LogNode {
        std::string name;
        std::string ip;
        int port;
    };

    void send_telemetry(const std::string& msg, const std::string& level, 
                        LogNode sender, LogNode receiver,
                        uint8_t* raw = nullptr, int raw_len = 0) {
        if (tel_socket_ < 0) return;

        sockaddr_in ts_addr;
        memset(&ts_addr, 0, sizeof(ts_addr));
        ts_addr.sin_family = AF_INET;
        ts_addr.sin_port = htons(config_.telemetryPort);
        inet_pton(AF_INET, "127.0.0.1", &ts_addr.sin_addr);

        std::stringstream ss;
        ss << R"({"level":")" << level << R"(","message":")" << msg << R"(")";
        
        if (!sender.name.empty()) {
            ss << R"(,"sender":{"name":")" << sender.name << R"(","ip":")" << sender.ip << R"(","port":)" << sender.port << "}";
        }
        
        LogNode effective_receiver = receiver;
        if (!effective_receiver.name.empty()) {
            if (effective_receiver.ip.empty()) effective_receiver.ip = "127.0.0.1";
            ss << R"(,"receiver":{"name":")" << effective_receiver.name << R"(","ip":")" << effective_receiver.ip << R"(","port":)" << effective_receiver.port << "}";
        }
        
        if (raw && raw_len > 0) {
            ss << R"(,"size":)" << raw_len;
            ss << R"(,"payload":")" << format_payload_hex(raw, raw_len) << R"(")";
        }
        ss << R"(})";

        std::string payload = ss.str();
        sendto(tel_socket_, payload.c_str(), payload.length(), 0, (struct sockaddr*)&ts_addr, sizeof(ts_addr));
    }

    std::string format_payload_hex(uint8_t* data, int len) {
        if (!data) return "";
        std::stringstream ss;
        int i = 0;
        while (i < len) {
            if (data[i] == 0x00) {
                int start = i;
                while (i < len && data[i] == 0x00) i++;
                const int count = i - start;
                if (count > 6) {
                    ss << "00 00 00 ... 00 00 00";
                } else {
                    for (int k = 0; k < count; k++) {
                        ss << "00";
                        if (k < count - 1) ss << " ";
                    }
                }
            } else {
                ss << std::hex << std::setw(2) << std::setfill('0') << (int)data[i];
                i++;
            }
            if (i < len) ss << " ";
        }
        return ss.str();
    }

    int get_actual_port(int sock) {
        if (sock < 0) return 0;
        sockaddr_in addr;
        socklen_t len = sizeof(addr);
        if (getsockname(sock, (struct sockaddr*)&addr, &len) == 0) {
            return ntohs(addr.sin_port);
        }
        return 0;
    }

    void close_socket(int s) {
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
    }

    YavConfig config_;
    std::string yals_ip_;
    int yals_port_;
    int cmd_socket_;
    int yals_socket_;
    int tel_socket_;
    int asn_socket_;
    std::atomic<bool> running_;
    std::atomic<bool> asn_test_active_;
    YVToYLSPacket current_yav_;
    std::string last_operator_ip_;
    int last_operator_port_;
};

int main(int argc, char* argv[]) {
    YavConfig config;

    std::cout << "YAV Client VERSION: 1.0.8" << std::endl;
    std::cout << "YAV Client started with " << argc << " arguments:" << std::endl;
    for (int i = 0; i < argc; ++i) {
        std::cout << "  argv[" << i << "] = " << argv[i] << std::endl;
    }

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--operator_ip" && i + 1 < argc) {
            std::string op_ip = argv[++i];
            if (!op_ip.empty()) config.operatorIp = op_ip;
        }
        else if (arg == "--operator_local_port" && i + 1 < argc) config.operatorLocalPort = std::stoi(argv[++i]);
        else if (arg == "--operator_remote_port" && i + 1 < argc) config.operatorRemotePort = std::stoi(argv[++i]);
        else if (arg == "--yav_ip" && i + 1 < argc) config.yavIp = argv[++i];
        else if (arg == "--yals_ip" && i + 1 < argc) config.yalsIp = argv[++i];
        else if (arg == "--yals_local_port" && i + 1 < argc) config.yalsLocalPort = std::stoi(argv[++i]);
        else if (arg == "--yals_remote_port" && i + 1 < argc) config.yalsRemotePort = std::stoi(argv[++i]);
        else if (arg == "--telemetry_port" && i + 1 < argc) config.telemetryPort = std::stoi(argv[++i]);
        else if (arg == "--autostart") config.autostart = true;
        else if (arg == "--asn_ip" && i + 1 < argc) config.asnIp = argv[++i];
        else if (arg == "--asn_local_port" && i + 1 < argc) config.asnLocalPort = std::stoi(argv[++i]);
        else if (arg == "--asn_remote_port" && i + 1 < argc) config.asnRemotePort = std::stoi(argv[++i]);
        else if (arg == "--asn_period" && i + 1 < argc) config.asnPeriod = std::stoi(argv[++i]);
    }

    YavService service(config);
    if (!service.init()) return 1;
    service.run();
    return 0;
}
