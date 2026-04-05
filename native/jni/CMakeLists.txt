cmake_minimum_required(VERSION 3.22.1)

project(sbagenxbridge LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(SBAGENX_LIBS_DIR ${CMAKE_CURRENT_LIST_DIR}/../sbagenxlib/libs)
set(SBAGENX_OGG_ARCHIVE ${SBAGENX_LIBS_DIR}/android-${ANDROID_ABI}-libogg.a)
set(SBAGENX_VORBISIDEC_ARCHIVE ${SBAGENX_LIBS_DIR}/android-${ANDROID_ABI}-libvorbisidec.a)
set(SBAGENX_MAD_ARCHIVE ${SBAGENX_LIBS_DIR}/android-${ANDROID_ABI}-libmad.a)

if(NOT EXISTS ${SBAGENX_OGG_ARCHIVE})
  message(FATAL_ERROR "Missing sbagenx Android libogg archive for ABI ${ANDROID_ABI}: ${SBAGENX_OGG_ARCHIVE}")
endif()

if(NOT EXISTS ${SBAGENX_VORBISIDEC_ARCHIVE})
  message(FATAL_ERROR "Missing sbagenx Android libvorbisidec archive for ABI ${ANDROID_ABI}: ${SBAGENX_VORBISIDEC_ARCHIVE}")
endif()

if(NOT EXISTS ${SBAGENX_MAD_ARCHIVE})
  message(FATAL_ERROR "Missing sbagenx Android libmad archive for ABI ${ANDROID_ABI}: ${SBAGENX_MAD_ARCHIVE}")
endif()

add_library(sbagenx_ogg STATIC IMPORTED)
set_target_properties(
  sbagenx_ogg
  PROPERTIES
  IMPORTED_LOCATION ${SBAGENX_OGG_ARCHIVE}
)

add_library(sbagenx_vorbisidec STATIC IMPORTED)
set_target_properties(
  sbagenx_vorbisidec
  PROPERTIES
  IMPORTED_LOCATION ${SBAGENX_VORBISIDEC_ARCHIVE}
)

add_library(sbagenx_mad STATIC IMPORTED)
set_target_properties(
  sbagenx_mad
  PROPERTIES
  IMPORTED_LOCATION ${SBAGENX_MAD_ARCHIVE}
)

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
  SBAGENXLIB_VERSION="android-v3.9.0-alpha.9-4fc7857"
  OGG_DECODE
  MP3_DECODE
  FLAC_DECODE
)

find_library(android-lib android)
find_library(dl-lib dl)
find_library(log-lib log)
find_library(math-lib m)

target_link_libraries(
  sbagenxbridge
  PRIVATE
  sbagenx_vorbisidec
  sbagenx_ogg
  sbagenx_mad
  ${android-lib}
  ${dl-lib}
  ${log-lib}
  ${math-lib}
)
