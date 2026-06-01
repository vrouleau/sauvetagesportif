#!/usr/bin/env python3
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
