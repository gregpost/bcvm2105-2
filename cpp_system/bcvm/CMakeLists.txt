cmake_minimum_required(VERSION 3.10)
project(YAV_Client)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build shared libraries" FORCE)
set(CMAKE_EXE_LINKER_FLAGS "-static")
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(yav_client main.cpp)

target_include_directories(yav_client PRIVATE 
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/../../../boost/include
)

if(UNIX)
    target_link_libraries(yav_client pthread)
endif()
