#!/bin/bash
# Build script for YAV Client

SRC_DIR=$(pwd)
BUILD_DIR="../../build/bcvm"

# 1. Handle cross-compilation flags
if [[ "$1" == "--arm" ]]; then
    echo "🔧 Setting up ARM (gnueabihf) cross-compilation..."
    
    # Pre-check for arm compiler (support both generic arm-linux-gnueabihf and official arm-none-linux-gnueabihf)
    ARM_GXX=""
    ARM_GCC=""
    if command -v arm-linux-gnueabihf-g++ &> /dev/null; then
        ARM_GXX="arm-linux-gnueabihf-g++"
        ARM_GCC="arm-linux-gnueabihf-gcc"
    elif command -v arm-none-linux-gnueabihf-g++ &> /dev/null; then
        ARM_GXX="arm-none-linux-gnueabihf-g++"
        ARM_GCC="arm-none-linux-gnueabihf-gcc"
    fi

    if [[ -z "$ARM_GXX" ]]; then
        echo "❌ Error: Neither arm-linux-gnueabihf-g++ nor arm-none-linux-gnueabihf-g++ compiler is found in PATH."
        echo ""
        echo "----------------------------------------------------------------"
        echo "For ARM Linux cross-compilation, you must either:"
        echo "1. Ensure our automatic toolchain installer downloads and configures it."
        echo "2. Install an 'arm-linux-gnueabihf' cross-compiler toolchain manually."
        echo "3. Run this project within the cloud container or WSL and install via apt."
        echo "----------------------------------------------------------------"
        exit 1
    fi
    
    export CC="$ARM_GCC"
    export CXX="$ARM_GXX"
    # We must clean the build directory when changing toolchains
    rm -rf "$BUILD_DIR"
else
    # Default: Try to find local compilers or use environment if set
    if [ -z "$CXX" ] && ! command -v g++ &> /dev/null; then
        # Fallback to Miniconda if present
        if [ -d "$HOME/miniconda3/bin" ]; then
            export PATH="$HOME/miniconda3/bin:$PATH"
            if [ -x "$HOME/miniconda3/bin/x86_64-conda-linux-gnu-g++" ]; then
                export CC="$HOME/miniconda3/bin/x86_64-conda-linux-gnu-gcc"
                export CXX="$HOME/miniconda3/bin/x86_64-conda-linux-gnu-g++"
            fi
        fi
    fi
fi

echo "--- Build Environment ---"
echo "Effective CXX: ${CXX:-$(command -v g++ || echo 'Not found')}"
echo "Effective CC: ${CC:-$(command -v gcc || echo 'Not found')}"
echo "Miniconda path: $HOME/miniconda3"
echo "------------------------"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR" || exit

declare -a CMAKE_OPTS=()
if [[ "$1" == "--arm" ]]; then
    CMAKE_OPTS=(-DCMAKE_SYSTEM_NAME=Linux -DCMAKE_SYSTEM_PROCESSOR=arm -DCMAKE_C_COMPILER="$ARM_GCC" -DCMAKE_CXX_COMPILER="$ARM_GXX")
    
    IS_WINDOWS=false
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OS" == "Windows_NT" || -n "$WINDIR" || "$(uname)" =~ "MINGW" || "$(uname)" =~ "MSYS" ]]; then
        IS_WINDOWS=true
    fi

    if [[ "$IS_WINDOWS" == "true" ]]; then
        if command -v ninja &> /dev/null || command -v ninja.exe &> /dev/null; then
            CMAKE_OPTS+=(-G "Ninja")
        elif command -v mingw32-make &> /dev/null || command -v mingw32-make.exe &> /dev/null; then
            CMAKE_OPTS+=(-G "MinGW Makefiles")
        elif command -v make &> /dev/null || command -v make.exe &> /dev/null; then
            CMAKE_OPTS+=(-G "Unix Makefiles")
        else
            # Default to Ninja if on Windows which is guaranteed to be in the toolchain PATH
            CMAKE_OPTS+=(-G "Ninja")
        fi
    fi
fi

echo "Configuring project with: cmake ${CMAKE_OPTS[@]} \"$SRC_DIR\""
cmake "${CMAKE_OPTS[@]}" "$SRC_DIR"

echo "Building project..."
cmake --build .

echo "Locating build binary..."
FOUND_BINARY=""
if [ -f "yav_client" ]; then
    FOUND_BINARY="yav_client"
elif [ -f "Debug/yav_client.exe" ]; then
    FOUND_BINARY="Debug/yav_client.exe"
elif [ -f "Release/yav_client.exe" ]; then
    FOUND_BINARY="Release/yav_client.exe"
elif [ -f "Debug/yav_client" ]; then
    FOUND_BINARY="Debug/yav_client"
elif [ -f "Release/yav_client" ]; then
    FOUND_BINARY="Release/yav_client"
elif [ -f "yav_client.exe" ]; then
    FOUND_BINARY="yav_client.exe"
fi

if [ -n "$FOUND_BINARY" ]; then
    echo "Found compiled binary: $FOUND_BINARY"
    cp "$FOUND_BINARY" "$SRC_DIR/yav_client"
    if [[ "$1" == "--arm" ]]; then
        cp "$FOUND_BINARY" "$SRC_DIR/yav_client_arm"
    fi
else
    echo "❌ Error: Compiled binary yav_client not found in build directory!"
    exit 1
fi
