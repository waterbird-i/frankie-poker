// Room registry: maps a room code to its table, creating tables on demand and
// dropping the ones nobody is connected to or seated at.

import { TableConfig } from "../services/tableController";
import { Room } from "./room";

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly config: TableConfig) {}

  get(code: string): Room {
    let room = this.rooms.get(code);
    if (!room) {
      room = new Room(code, this.config);
      room.start();
      this.rooms.set(code, room);
    }
    return room;
  }

  /** Drops idle tables so a long-running process does not accumulate them. */
  sweep(): void {
    this.rooms.forEach((room, code) => {
      if (room.isIdle) {
        room.stop();
        this.rooms.delete(code);
      }
    });
  }

  get size(): number {
    return this.rooms.size;
  }

  list(): { code: string; connections: number }[] {
    return [...this.rooms.entries()].map(([code, room]) => ({ code, connections: room.size }));
  }

  closeAll(): void {
    this.rooms.forEach((room) => room.stop());
    this.rooms.clear();
  }
}
