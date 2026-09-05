cmake_minimum_required(VERSION 3.20)
project(cursor-monitor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(cursor-monitor src/main.cpp)

target_link_libraries(cursor-monitor PRIVATE user32)
