cmake_minimum_required(VERSION 3.10)
project(YALS_Server)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build shared libraries" FORCE)
set(CMAKE_EXE_LINKER_FLAGS "-static")
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(yals_server main.cpp)

target_include_directories(yals_server PRIVATE 
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../boost/include
)

if(UNIX)
    target_link_libraries(yals_server pthread)
endif()
