#!/bin/bash
# script_name: run_build_scripts.sh
# Dual-purpose developer build & deploy tool

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SKIP_BUILD=false
NO_YALS=false

# Simple argument parsing
for arg in "$@"; do
    case $arg in
        --no-build|-nb)
            SKIP_BUILD=true
            ;;
        --no-yals|-ny)
            NO_YALS=true
            ;;
        *)
            # other options could go here
            ;;
    esac
done

if [ "$SKIP_BUILD" = false ]; then
    echo -e "${BLUE}>>> Performing git pull in project root...${NC}"
    git pull

    # Build options
    BUILD_COMMAND="npx tsx run_build_scripts.ts --arm"
    if [ "$NO_YALS" = true ]; then
        BUILD_COMMAND="$BUILD_COMMAND --no-yals"
        echo -e "${YELLOW}>>> Configuring build to compile BCVM & ASN only (Skipping YALS)...${NC}"
    else
        echo -e "${BLUE}>>> Configuring build to compile all modules (BCVM, YALS, ASN)...${NC}"
    fi

    echo -e "${BLUE}>>> Compiling targets...${NC}"
    $BUILD_COMMAND
else
    echo -e "${YELLOW}>>> Skipped build and git pull (--no-build). Sending previously compiled binary.${NC}"
fi

# SSH Deployment steps for BCVM (YAV Client)
BINARY_PATH=""
if [ -f "./build/bcvm/yav_client_arm" ]; then
    BINARY_PATH="./build/bcvm/yav_client_arm"
elif [ -f "./cpp_system/bcvm/yav_client_arm" ]; then
    BINARY_PATH="./cpp_system/bcvm/yav_client_arm"
elif [ -f "./build/bcvm/yav_client" ]; then
    BINARY_PATH="./build/bcvm/yav_client"
elif [ -f "./cpp_system/bcvm/yav_client" ]; then
    BINARY_PATH="./cpp_system/bcvm/yav_client"
fi

if [ ! -f "$BINARY_PATH" ]; then
    echo -e "${RED}Error: yav_client executable not found at ${BINARY_PATH}! Please build it first.${NC}"
    exit 1
fi

echo -e "${BLUE}>>> Flushing IP addresses on enp0s8...${NC}"
sudo ip addr flush dev enp0s8 || echo -e "${YELLOW}Warning: Failed to flush IP. Continuing...${NC}"

echo -e "${BLUE}>>> Adding IP 192.168.17.233/24 to enp0s8...${NC}"
sudo ip addr add 192.168.17.233/24 dev enp0s8 || echo -e "${YELLOW}Warning: Failed to set IP. Continuing...${NC}"

echo -e "${GREEN}>>> Securely deploying yav_client to BCVM (${BINARY_PATH} -> root@192.168.17.246:/home)...${NC}"
scp "$BINARY_PATH" root@192.168.17.246:/home

echo -e "${GREEN}>>> Done.${NC}"
