cmake_minimum_required(VERSION 3.22.1)

project(sbagenxbridge LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(
  sbagenxbridge
  SHARED
  sbagenx_bridge.cpp
  ../sbagenxlib/sbagenxlib.c
)

target_include_directories(
  sbagenxbridge
  PRIVATE
  ../sbagenxlib
  ../sbagenxlib/libs
)

target_compile_definitions(
  sbagenxbridge
  PRIVATE
  SBAGENXLIB_VERSION="android-gui-v3.0-5088272"
)

find_library(android-lib android)
find_library(dl-lib dl)
find_library(log-lib log)
find_library(math-lib m)

target_link_libraries(
  sbagenxbridge
  PRIVATE
  ${android-lib}
  ${dl-lib}
  ${log-lib}
  ${math-lib}
)
