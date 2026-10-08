@echo off
rem Spawns a node GRANDCHILD (cmd.exe -> node). Used by kill-tree.test.ts to
rem prove killAgentProcessTree reaps the whole tree, not just the cmd wrapper.
node "%~dp0tree-child.mjs"
