// web/src/game/state.ts
// Pure Connect 4 game state. No DOM, no Pixi, no fetch.
// The move sequence string is the canonical state; everything else is derived.

export type Cell = "yellow" | "green";
export type Status = "ongoing" | "won" | "draw";

export const WIDTH = 7;
export const HEIGHT = 6;

export class GameState {
  moves: string = "";
  grid: (Cell | null)[][] = Array.from({ length: WIDTH }, () => Array<Cell | null>(HEIGHT).fill(null));
  toMove: Cell = "yellow";
  status: Status = "ongoing";
  winner: Cell | null = null;
  winningCells: Array<[number, number]> = [];

  static fromSequence(moves: string): GameState {
    const g = new GameState();
    for (const ch of moves) g.applyMove(parseInt(ch, 10));
    return g;
  }

  legalColumns(): number[] {
    const out: number[] = [];
    for (let c = 0; c < WIDTH; c++) if (this.heightOf(c) < HEIGHT) out.push(c);
    return out;
  }

  heightOf(col: number): number {
    let h = 0;
    while (h < HEIGHT && this.grid[col][h] !== null) h++;
    return h;
  }

  applyMove(col: number): { row: number; player: Cell } {
    if (this.status !== "ongoing") throw new Error("game over");
    if (!Number.isInteger(col) || col < 0 || col >= WIDTH) throw new Error(`column out of range: ${col}`);
    const row = this.heightOf(col);
    if (row >= HEIGHT) throw new Error(`column ${col} full`);
    const player = this.toMove;
    this.grid[col][row] = player;
    this.moves += String(col);
    const win = this.findWinThrough(col, row, player);
    if (win) {
      this.status = "won";
      this.winner = player;
      this.winningCells = win;
    } else if (this.moves.length === WIDTH * HEIGHT) {
      this.status = "draw";
    } else {
      this.toMove = player === "yellow" ? "green" : "yellow";
    }
    return { row, player };
  }

  private findWinThrough(col: number, row: number, player: Cell): Array<[number, number]> | null {
    const dirs: Array<[number, number]> = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of dirs) {
      const line: Array<[number, number]> = [[col, row]];
      for (let step = 1; step < 4; step++) {
        const x = col + dx * step, y = row + dy * step;
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || this.grid[x][y] !== player) break;
        line.push([x, y]);
      }
      for (let step = 1; step < 4; step++) {
        const x = col - dx * step, y = row - dy * step;
        if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT || this.grid[x][y] !== player) break;
        line.unshift([x, y]);
      }
      if (line.length >= 4) return line.slice(0, 4);
    }
    return null;
  }
}
