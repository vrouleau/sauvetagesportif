#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Vincent Rouleau <https://github.com/vrouleau/sauvetagesportif>
#
# This file is part of Sauvetage Sportif.
#
# Sauvetage Sportif is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Sauvetage Sportif is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with Sauvetage Sportif. If not, see <https://www.gnu.org/licenses/>.

"""TCP proxy: 0.0.0.0:TARGET_PORT -> localhost:TARGET_PORT
Runs in WSL host network namespace so mirrored networking exposes it on LAN."""
import socket, threading, sys

TARGET_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
LISTEN_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else TARGET_PORT + 1000

def pipe(src, dst):
    try:
        while True:
            data = src.recv(4096)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(client):
    try:
        server = socket.create_connection(('127.0.0.1', TARGET_PORT))
        threading.Thread(target=pipe, args=(client, server), daemon=True).start()
        threading.Thread(target=pipe, args=(server, client), daemon=True).start()
    except Exception as e:
        print(f"connect error: {e}")
        client.close()

sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)  # dual-stack
sock.bind(('::', LISTEN_PORT))
sock.listen(50)
print(f"Forwarding 0.0.0.0:{LISTEN_PORT} -> localhost:{TARGET_PORT}", flush=True)

while True:
    client, addr = sock.accept()
    threading.Thread(target=handle, args=(client,), daemon=True).start()