# Project Guidelines

- **C++ Compilation**: Always run `npx tsx run_build_scripts.ts` after modifying any `.cpp` or `CMakeLists.txt` files to ensure the latest binaries are used.
- **Environment**: If `g++`, `cmake`, or `make` are missing, run `npx tsx gpp_installer.ts` first.
- **Sim Mode**: The application supports 'ts' (TypeScript), 'cpp' (C++), and 'hw' (Real Hardware) modes.
