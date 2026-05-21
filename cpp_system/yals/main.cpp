#include <iostream>
#include <vector>
#include <string>
#include <cstring>
#include <chrono>
#include <thread>
#include <sstream>
#include <iomanip>

#ifdef _WIN32
    #include <winsock2.h>
    #include <ws2tcpip.h>
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

const int TEL_PORT = 5006;

void close_socket(int s) {
#ifdef _WIN32
    closesocket(s);
#else
    close(s);
#endif
}

std::string format_payload_hex(uint8_t* data, int len) {
    std::stringstream ss;
    int i = 0;
    while (i < len) {
        if (data[i] == 0x00) {
            int start = i;
            while (i < len && data[i] == 0x00) i++;
            int count = i - start;
            if (count > 5) {
                ss << "00 00 00 00 00 ... 00 00 00 00 00";
            } else {
                for (int k = 0; k < count; k++) {
                    ss << "00";
                    if (k < count - 1) ss << " ";
                }
            }
        } else {
            ss << std::hex << std::setw(2) << std::setfill('0') << std::uppercase << (int)data[i];
            i++;
        }
        if (i < len) ss << " ";
    }
    return ss.str();
}

struct LogNode {
    std::string name;
    std::string ip;
    int port;
};

void send_telemetry(const std::string& msg, const std::string& level, 
                    LogNode sender = {}, LogNode receiver = {}, 
                    uint8_t* raw = nullptr, int raw_len = 0) {
    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) return;

    sockaddr_in ts_addr;
    memset(&ts_addr, 0, sizeof(ts_addr));
    ts_addr.sin_family = AF_INET;
    ts_addr.sin_port = htons(TEL_PORT);
    inet_pton(AF_INET, "127.0.0.1", &ts_addr.sin_addr);

    std::stringstream ss;
    ss << R"({"level":")" << level << R"(","message":"ЯЛС: )" << msg << R"(",)";
    if (!sender.name.empty()) {
        ss << R"("sender":{"name":")" << sender.name << R"(","ip":")" << sender.ip << R"(","port":)" << sender.port << "},";
    }
    if (!receiver.name.empty()) {
        ss << R"("receiver":{"name":")" << receiver.name << R"(","ip":")" << receiver.ip << R"(","port":)" << receiver.port << "}";
    }
    if (raw && raw_len > 0) {
        ss << R"(,"size":)" << raw_len;
        ss << R"(,"payload":")" << format_payload_hex(raw, raw_len) << R"(")";
    }
    ss << R"(})";

    std::string payload = ss.str();
    sendto(sock, payload.c_str(), payload.length(), 0, (struct sockaddr*)&ts_addr, sizeof(ts_addr));
    close_socket(sock);
}

int main(int argc, char* argv[]) {
    int port = 101;
    if (argc > 1) port = std::stoi(argv[1]);

#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif

    int sock = socket(AF_INET, SOCK_DGRAM, 0);
    if (sock < 0) return 1;

    sockaddr_in server_addr;
    memset(&server_addr, 0, sizeof(server_addr));
    server_addr.sin_family = AF_INET;
    server_addr.sin_addr.s_addr = INADDR_ANY;
    server_addr.sin_port = htons(port);

    if (bind(sock, (struct sockaddr*)&server_addr, sizeof(server_addr)) < 0) {
        std::cerr << "YALS failed to bind to port " << port << std::endl;
        return 1;
    }

    std::cout << "YALS Server VERSION: 1.0.8" << std::endl;
    std::cout << "YALS Simulator running on port " << port << std::endl;

    uint8_t request[65535];
    sockaddr_in client_addr;
    socklen_t client_len = sizeof(client_addr);

    while (true) {
        int n = recvfrom(sock, (char*)request, sizeof(request), 0, (struct sockaddr*)&client_addr, &client_len);
        if (n > 0) {
            const char* yals_ip = "127.0.0.1";
            const char* yav_ip = "127.0.0.1";

            bool is_correct_size = (n == 152);
            bool is_correct_index = (request[0] == 0x01); 
            bool is_correct_command = (request[1] == 0x01 || request[1] == 0x08);

            bool should_respond = is_correct_size && is_correct_index && is_correct_command;

            if (should_respond) {
                uint8_t response[8192];
                memset(response, 0, 8192);
                response[0] = request[0];
                response[1] = (request[1] == 0x01 ? 0x03 : 0x04);
                
                sendto(sock, (char*)response, 8192, 0, (struct sockaddr*)&client_addr, client_len);
            } else {
                std::string reason = "";
                if (!is_correct_size) reason += "неверный размер; ";
                if (!is_correct_index) reason += "неверный индекс; ";
                if (!is_correct_command) reason += "неверная команда; ";

                std::cout << "ЯЛС: Игнорирование пакета: " << reason << std::endl;
                
                send_telemetry("Игнорирование пакета: " + reason, "WARNING",
                    { "БЦВМ", yav_ip, ntohs(client_addr.sin_port) },
                    { "ЯЛС", yals_ip, port },
                    request, n
                );
            }
        }
    }

    close_socket(sock);
    return 0;
}
