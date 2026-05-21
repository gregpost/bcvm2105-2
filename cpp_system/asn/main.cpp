#include <iostream>
#include <vector>
#include <string>
#include <thread>
#include <chrono>
#include <cstring>
#include <atomic>
#include <sstream>
#include <iomanip>

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

// CRC XOR over bytes 0..6
uint8_t calculate_crc8(const uint8_t* data, size_t len) {
    uint8_t crc = 0;
    for (size_t i = 0; i < len; ++i) {
        crc ^= data[i];
    }
    return crc;
}

void close_socket(int s) {
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
}

struct LogNode {
    std::string name;
    std::string ip;
    int port;
};

void send_telemetry(int tel_socket, int telemetry_port, const std::string& msg, const std::string& level, 
                    const LogNode& sender, const LogNode& receiver,
                    const uint8_t* raw = nullptr, int raw_len = 0) {
    if (tel_socket < 0) return;

    sockaddr_in ts_addr;
    memset(&ts_addr, 0, sizeof(ts_addr));
    ts_addr.sin_family = AF_INET;
    ts_addr.sin_port = htons(telemetry_port);
    inet_pton(AF_INET, "127.0.0.1", &ts_addr.sin_addr);

    std::stringstream ss;
    ss << R"({"level":")" << level << R"(","message":")" << msg << R"(",)";
    ss << R"("sender":{"name":")" << sender.name << R"(","ip":")" << sender.ip << R"(","port":)" << sender.port << "},";
    ss << R"("receiver":{"name":")" << receiver.name << R"(","ip":")" << receiver.ip << R"(","port":)" << receiver.port << "}";
    
    if (raw && raw_len > 0) {
        ss << R"(,"size":)" << raw_len;
        
        std::stringstream hex_ss;
        for (int i = 0; i < raw_len; ++i) {
            hex_ss << std::hex << std::setw(2) << std::setfill('0') << std::uppercase << (int)raw[i];
            if (i < raw_len - 1) hex_ss << " ";
        }
        ss << R"(,"payload":")" << hex_ss.str() << R"(")";
    }
    ss << R"(})";

    std::string payload = ss.str();
    sendto(tel_socket, payload.c_str(), payload.length(), 0, (struct sockaddr*)&ts_addr, sizeof(ts_addr));
}

int main(int argc, char* argv[]) {
    int asn_port = 102;
    std::string yav_ip = "127.0.0.1";
    int yav_asn_port = 103;
    int telemetry_port = 5006;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--asn_port" && i + 1 < argc) asn_port = std::stoi(argv[++i]);
        else if (arg == "--yav_ip" && i + 1 < argc) yav_ip = argv[++i];
        else if (arg == "--yav_asn_port" && i + 1 < argc) yav_asn_port = std::stoi(argv[++i]);
        else if (arg == "--telemetry_port" && i + 1 < argc) telemetry_port = std::stoi(argv[++i]);
    }

    std::cout << "ASN simulator VERSION: 1.0.0" << std::endl;
    std::cout << "ASN simulator running on port " << asn_port << std::endl;
    std::cout << "Target YAV IP: " << yav_ip << ", Port: " << yav_asn_port << std::endl;
    std::cout << "Telemetry port: " << telemetry_port << std::endl;

#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

    int server_sock = socket(AF_INET, SOCK_DGRAM, 0);
    int tel_sock = socket(AF_INET, SOCK_DGRAM, 0);

    if (server_sock < 0 || tel_sock < 0) {
        std::cerr << "ASN: failed to create sockets" << std::endl;
        return 1;
    }

    sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(asn_port);

    if (bind(server_sock, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        std::cerr << "ASN: failed to bind to port " << asn_port << std::endl;
        return 1;
    }

    uint8_t rx_buffer[1024];
    sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);

    // Set a small socket receive timeout (1 ms) to allow for single-threaded periodic ticks
    struct timeval tv_asn;
    tv_asn.tv_sec = 0;
    tv_asn.tv_usec = 1000; // 1 ms timeout
    setsockopt(server_sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv_asn, sizeof(tv_asn));

    bool ticking = false;
    int period_ms = 2000;
    uint32_t ts_counter = 0;

    auto last_tick_time = std::chrono::steady_clock::now();
    auto last_log_time = std::chrono::steady_clock::now();

    while (true) {
        int n = recvfrom(server_sock, (char*)rx_buffer, sizeof(rx_buffer), 0, (struct sockaddr*)&client_addr, &client_len);
        if (n > 0) {
            char client_ip[INET_ADDRSTRLEN];
            inet_ntop(AF_INET, &client_addr.sin_addr, client_ip, INET_ADDRSTRLEN);
            int client_port = ntohs(client_addr.sin_port);

            if (n != 8) {
                std::cerr << "ASN: invalid packet size: " << n << std::endl;
                continue;
            }

            uint8_t sync_byte = rx_buffer[0];
            if (sync_byte != 0xAA) {
                std::cerr << "ASN: invalid sync byte: " << (int)sync_byte << std::endl;
                continue;
            }

            uint8_t received_crc = rx_buffer[7];
            uint8_t calculated_crc = calculate_crc8(rx_buffer, 7);
            if (received_crc != calculated_crc) {
                std::cerr << "ASN: invalid CRC: " << (int)received_crc << " vs calculated " << (int)calculated_crc << std::endl;
                continue;
            }

            uint8_t cmd = rx_buffer[1];
            if (cmd == 0x01) { // SETUP
                uint16_t parsed_period = (rx_buffer[2] << 8) | rx_buffer[3];
                if (parsed_period > 0) {
                    period_ms = parsed_period;
                }
                
                std::stringstream ss_msg;
                if (parsed_period == 0) {
                    ss_msg << "АСН: Получена команда [НАСТРОЙКА] с нулевой частотой от БЦВМ (текущий период сохранен: " << period_ms << " мс)";
                } else {
                    ss_msg << "АСН: Получена команда [НАСТРОЙКА] от БЦВМ. Период: " << parsed_period << " мс";
                }
                
                send_telemetry(tel_sock, telemetry_port, ss_msg.str(), "SUCCESS",
                    { "АСН", "127.0.0.1", asn_port },
                    { "БЦВМ", client_ip, client_port },
                    rx_buffer, n
                );

                ticking = true;
                ts_counter = 0;
                last_tick_time = std::chrono::steady_clock::now();

                // Send the first tick immediately
                {
                    uint16_t current_ts = ts_counter;
                    ts_counter = (ts_counter + 1) % 65536;
                    uint8_t ts_H = (current_ts >> 8) & 0xFF;
                    uint8_t ts_L = current_ts & 0xFF;

                    uint8_t pkt[8] = { 0xBB, 0x00, ts_H, ts_L, 0x00, 0x00, 0x00, 0 };
                    pkt[7] = calculate_crc8(pkt, 7);

                    sockaddr_in target_yav_addr;
                    memset(&target_yav_addr, 0, sizeof(target_yav_addr));
                    target_yav_addr.sin_family = AF_INET;
                    target_yav_addr.sin_port = htons(yav_asn_port);
                    inet_pton(AF_INET, yav_ip.c_str(), &target_yav_addr.sin_addr);

                    std::stringstream ss_msg2;
                    ss_msg2 << "АСН: Отправка такта " << current_ts << " (" << period_ms << " мс)";
                    send_telemetry(tel_sock, telemetry_port, ss_msg2.str(), "INFO",
                        { "АСН", "127.0.0.1", asn_port },
                        { "БЦВМ", yav_ip, yav_asn_port },
                        pkt, 8
                    );

                    sendto(server_sock, (const char*)pkt, 8, 0, (struct sockaddr*)&target_yav_addr, sizeof(target_yav_addr));
                }

            } else if (cmd == 0x02) { // STOP
                ticking = false;

                // Send STOP response back to YAV client (client_addr)
                uint8_t stop_resp_pkt[8] = { 0xBB, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0 };
                stop_resp_pkt[7] = calculate_crc8(stop_resp_pkt, 7);

                std::stringstream ss_msg;
                ss_msg << "АСН: Отправка подтверждения остановки";
                send_telemetry(tel_sock, telemetry_port, ss_msg.str(), "SUCCESS",
                    { "АСН", "127.0.0.1", asn_port },
                    { "БЦВМ", client_ip, client_port },
                    stop_resp_pkt, 8
                );

                sendto(server_sock, (const char*)stop_resp_pkt, 8, 0, (struct sockaddr*)&client_addr, client_len);
            }
        }

        // Handle periodic ticks on the main thread
        if (ticking) {
            auto now = std::chrono::steady_clock::now();
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - last_tick_time).count();
            if (elapsed >= period_ms) {
                last_tick_time = now;

                uint16_t current_ts = ts_counter;
                ts_counter = (ts_counter + 1) % 65536;
                uint8_t ts_H = (current_ts >> 8) & 0xFF;
                uint8_t ts_L = current_ts & 0xFF;

                uint8_t pkt[8] = { 0xBB, 0x00, ts_H, ts_L, 0x00, 0x00, 0x00, 0 };
                pkt[7] = calculate_crc8(pkt, 7);

                sockaddr_in target_yav_addr;
                memset(&target_yav_addr, 0, sizeof(target_yav_addr));
                target_yav_addr.sin_family = AF_INET;
                target_yav_addr.sin_port = htons(yav_asn_port);
                inet_pton(AF_INET, yav_ip.c_str(), &target_yav_addr.sin_addr);

                std::stringstream ss_msg;
                ss_msg << "АСН: Отправка такта " << current_ts << " (" << period_ms << " мс)";
                send_telemetry(tel_sock, telemetry_port, ss_msg.str(), "INFO",
                    { "АСН", "127.0.0.1", asn_port },
                    { "БЦВМ", yav_ip, yav_asn_port },
                    pkt, 8
                );

                sendto(server_sock, (const char*)pkt, 8, 0, (struct sockaddr*)&target_yav_addr, sizeof(target_yav_addr));
            }
        }
    }

    close_socket(server_sock);
    close_socket(tel_sock);
    return 0;
}
