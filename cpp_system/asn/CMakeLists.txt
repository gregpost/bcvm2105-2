cmake_minimum_required(VERSION 3.10)
project(ASN_Simulator)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build shared libraries" FORCE)
set(CMAKE_EXE_LINKER_FLAGS "-static")
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(asn_simulator main.cpp)

if(UNIX)
    target_link_libraries(asn_simulator pthread)
endif()
