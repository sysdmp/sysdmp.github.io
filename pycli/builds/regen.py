#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Regenerate every build pair in this directory from its own recorded command.

Each builds/<name>.json embeds the exact command line that produced it (under
command.line). This script replays that command to refresh both the .json and the
matching .txt, so the committed samples always reflect the current output format.

Conventions:
  - .json: the recorded command verbatim (it ends in --json).
  - .txt : the same solve rendered as tables with --no-color --charset ascii
           (ascii keeps the captures diff-friendly and portable).

Usage:  uv run builds/regen.py      (run from the repo root)
"""
import json
import subprocess
import shlex
import glob
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SOLVER = os.path.join(os.path.dirname(HERE), "ddda-build-solver.py")

def main():
    jsons = sorted(glob.glob(os.path.join(HERE, "*.json")))
    if not jsons:
        print("no builds/*.json to regenerate")
        return
    for jf in jsons:
        base = jf[:-5]
        tf = base + ".txt"
        line = json.load(open(jf))["command"]["line"]
        # drop the program name and any --json; that leaves the bare solve args
        args = [a for a in shlex.split(line)[1:] if a != "--json"]
        with open(jf, "w") as fh:
            subprocess.run(["uv", "run", SOLVER, *args, "--json"],
                           stdout=fh, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        with open(tf, "w") as fh:
            subprocess.run(["uv", "run", SOLVER, *args, "--no-color", "--charset", "ascii"],
                           stdout=fh, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        print(f"regenerated {os.path.basename(jf)} + {os.path.basename(tf)}")

if __name__ == "__main__":
    main()
