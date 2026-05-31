# solver/CMakeLists.txt
cmake_minimum_required(VERSION 3.18)
project(pyconnect4 CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()
find_package(pybind11 CONFIG REQUIRED)

set(PONS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/connect4)

pybind11_add_module(_pyconnect4
    src/binding.cpp
    ${PONS_DIR}/Solver.cpp
)
target_include_directories(_pyconnect4 PRIVATE ${PONS_DIR})
target_compile_options(_pyconnect4 PRIVATE
    "$<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-O3;-Wall>"
    "$<$<CXX_COMPILER_ID:MSVC>:/O2;/W3>"
)
add_compile_definitions(NDEBUG)

install(TARGETS _pyconnect4 LIBRARY DESTINATION pyconnect4)
