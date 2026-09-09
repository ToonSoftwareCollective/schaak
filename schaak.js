	// Schaken tegen Toon: spelregels en de computerspeler.
	//
	// This file is deliberately written for a small, slow device (Toon 1: 128 MB RAM, no FPU,
	// interpreted JavaScript):
	//   - the position lives in a handful of module level arrays that are updated in place with
	//     make/take back, so the search allocates (almost) nothing per node;
	//   - moves are integers, move lists live in one flat preallocated array (TSCP style);
	//   - the search is iterative deepening with a hard time limit, so a slow processor gets a
	//     shallower search instead of a frozen screen.
	//
	// The same file is imported by SchaakApp.qml (rules, legal moves, game result) and included by
	// schaakWorker.js (the search runs in a worker thread). Both keep their own copy of the state.
	// No '.pragma library' on purpose: Qt.include() in a WorkerScript needs a plain script.
	//
	// Squares: 0 = a1, 7 = h1, 56 = a8, 63 = h8, so index = rank * 8 + file.
	// Pieces: positive = white, negative = black; the absolute value is the piece type.
	// Written in ES3 style (no Array.indexOf etc.) so it also runs on very old JavaScript engines.

var WHITE = 1;
var BLACK = -1;

var EMPTY = 0;
var PAWN = 1;
var KNIGHT = 2;
var BISHOP = 3;
var ROOK = 4;
var QUEEN = 5;
var KING = 6;

	// game results
var RUNNING = 0;
var CHECKMATE = 1;
var STALEMATE = 2;
var DRAW_REPETITION = 3;
var DRAW_FIFTY = 4;
var DRAW_MATERIAL = 5;

	// difficulty levels
var LEVEL_EASY = 1;
var LEVEL_NORMAL = 2;
var LEVEL_HARD = 3;

var MAX_PLY = 48;
var MATE = 100000;
var INFINITY = 1000000;

	// move encoding: from | to << 6 | promotion piece << 12 | flags << 15
var F_CAPTURE = 1;
var F_DOUBLE = 2;		// pawn double step
var F_EP = 4;			// en passant capture
var F_CASTLE = 8;
var F_PROMO = 16;

function moveFrom(m) { return m & 63; }
function moveTo(m) { return (m >> 6) & 63; }
function movePromo(m) { return (m >> 12) & 7; }
function moveFlags(m) { return m >> 15; }

	// ---------------------------------------------------------------------------------------------
	// position

var board = new Array(64);
var side = WHITE;
var castle = 0;			// bits: 1 white O-O, 2 white O-O-O, 4 black O-O, 8 black O-O-O
var ep = -1;			// en passant target square, -1 if none
var fifty = 0;			// half moves since the last capture or pawn move
var hash = 0;			// 32 bit Zobrist key of the position
var kingSq = [4, 60];	// [white king, black king]
var hply = 0;			// half moves made since newGame(), game moves plus search moves

	// undo information, indexed by hply
var undoMove = [];
var undoCapture = [];
var undoCastle = [];
var undoEp = [];
var undoFifty = [];
var undoHash = [];

	// 10x12 mailbox: MAILBOX maps a 120 index to a square (or -1 off the board), MAILBOX64 the reverse
var MAILBOX = new Array(120);
var MAILBOX64 = new Array(64);
(function () {
	for (var i = 0; i < 120; i++) MAILBOX[i] = -1;
	for (var s = 0; s < 64; s++) {
		var i120 = 21 + (s >> 3) * 10 + (s & 7);
		MAILBOX[i120] = s;
		MAILBOX64[s] = i120;
	}
})();

var OFFSETS = [
	[],
	[],
	[-21, -19, -12, -8, 8, 12, 19, 21],		// knight
	[-11, -9, 9, 11],						// bishop
	[-10, -1, 1, 10],						// rook
	[-11, -10, -9, -1, 1, 9, 10, 11],		// queen
	[-11, -10, -9, -1, 1, 9, 10, 11]		// king
];
var SLIDES = [false, false, false, true, true, true, false];

	// castling rights that survive a move from or to this square
var CASTLE_MASK = new Array(64);
(function () {
	for (var s = 0; s < 64; s++) CASTLE_MASK[s] = 15;
	CASTLE_MASK[0] = 13;	// a1 rook: white O-O-O gone
	CASTLE_MASK[7] = 14;	// h1 rook: white O-O gone
	CASTLE_MASK[4] = 12;	// white king
	CASTLE_MASK[56] = 7;	// a8 rook
	CASTLE_MASK[63] = 11;	// h8 rook
	CASTLE_MASK[60] = 3;	// black king
})();

	// ---------------------------------------------------------------------------------------------
	// Zobrist hashing (32 bit, xorshift generated so both engine copies agree)

var zobPiece = [];		// [piece + 6][square]
var zobCastle = [];
var zobEp = [];
var zobSide = 0;
(function () {
	var seed = 0x2545F491;
	function rnd() {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return seed | 0;
	}
	for (var p = 0; p < 13; p++) {
		zobPiece[p] = [];
		for (var s = 0; s < 64; s++) zobPiece[p][s] = rnd();
	}
	for (var c = 0; c < 16; c++) zobCastle[c] = rnd();
	for (var e = 0; e < 64; e++) zobEp[e] = rnd();
	zobSide = rnd();
})();

function computeHash() {
	var h = 0;
	for (var s = 0; s < 64; s++) {
		if (board[s] !== EMPTY) h ^= zobPiece[board[s] + 6][s];
	}
	h ^= zobCastle[castle];
	if (ep >= 0) h ^= zobEp[ep];
	if (side === BLACK) h ^= zobSide;
	return h;
}

	// ---------------------------------------------------------------------------------------------
	// setting up a position

var INITIAL_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

function newGame() {
	setFen(INITIAL_FEN);
}

var FEN_PIECES = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING };

function setFen(fen) {
	var parts = fen.split(" ");
	for (var s = 0; s < 64; s++) board[s] = EMPTY;

	var rank = 7;
	var file = 0;
	var rows = parts[0];
	for (var i = 0; i < rows.length; i++) {
		var ch = rows.charAt(i);
		if (ch === "/") {
			rank--;
			file = 0;
		} else if (ch >= "1" && ch <= "8") {
			file += parseInt(ch, 10);
		} else {
			var type = FEN_PIECES[ch.toLowerCase()];
			var colour = (ch === ch.toLowerCase()) ? BLACK : WHITE;
			var sq = rank * 8 + file;
			board[sq] = type * colour;
			if (type === KING) kingSq[colour === WHITE ? 0 : 1] = sq;
			file++;
		}
	}

	side = (parts.length > 1 && parts[1] === "b") ? BLACK : WHITE;

	castle = 0;
	if (parts.length > 2) {
		var c = parts[2];
		if (c.indexOf("K") >= 0) castle |= 1;
		if (c.indexOf("Q") >= 0) castle |= 2;
		if (c.indexOf("k") >= 0) castle |= 4;
		if (c.indexOf("q") >= 0) castle |= 8;
	}

	ep = -1;
	if (parts.length > 3 && parts[3] !== "-") ep = squareFromName(parts[3]);

	fifty = (parts.length > 4) ? parseInt(parts[4], 10) : 0;
	hply = 0;
	hash = computeHash();
}

function squareFromName(name) {
	return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

function squareName(sq) {
	return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 3));
}

	// copy of the board for the user interface
function getBoard() {
	return board.slice();
}

	// ---------------------------------------------------------------------------------------------
	// attack detection

	// piece on a 120 index, or a value that never matches a piece when off the board
function pieceAt120(i120) {
	var s = MAILBOX[i120];
	return (s < 0) ? -99 : board[s];
}

	// is 'sq' attacked by a piece of colour 'by'?
function attacked(sq, by) {
	var i120 = MAILBOX64[sq];
	var i;

	var pawn = PAWN * by;
	if (by === WHITE) {
		if (pieceAt120(i120 - 11) === pawn || pieceAt120(i120 - 9) === pawn) return true;
	} else {
		if (pieceAt120(i120 + 9) === pawn || pieceAt120(i120 + 11) === pawn) return true;
	}

	var knight = KNIGHT * by;
	var ko = OFFSETS[KNIGHT];
	for (i = 0; i < 8; i++) {
		if (pieceAt120(i120 + ko[i]) === knight) return true;
	}

	var king = KING * by;
	var kio = OFFSETS[KING];
	for (i = 0; i < 8; i++) {
		if (pieceAt120(i120 + kio[i]) === king) return true;
	}

	var queen = QUEEN * by;
	var bishop = BISHOP * by;
	var rook = ROOK * by;
	var bo = OFFSETS[BISHOP];
	for (i = 0; i < 4; i++) {
		var t = i120 + bo[i];
		var p = pieceAt120(t);
		while (p === EMPTY) {
			t += bo[i];
			p = pieceAt120(t);
		}
		if (p === bishop || p === queen) return true;
	}
	var ro = OFFSETS[ROOK];
	for (i = 0; i < 4; i++) {
		var t2 = i120 + ro[i];
		var p2 = pieceAt120(t2);
		while (p2 === EMPTY) {
			t2 += ro[i];
			p2 = pieceAt120(t2);
		}
		if (p2 === rook || p2 === queen) return true;
	}
	return false;
}

function inCheck() {
	return attacked(kingSq[side === WHITE ? 0 : 1], -side);
}

	// ---------------------------------------------------------------------------------------------
	// move generation
	//
	// Moves for search ply p live in genMoves[firstMove[p] .. firstMove[p + 1] - 1], with an ordering
	// score in genScores at the same index.

var genMoves = [];
var genScores = [];
var firstMove = [0];
var historyHeuristic = new Array(4096);	// move ordering: how often a quiet move caused a cutoff, indexed from * 64 + to
(function () {
	for (var h = 0; h < 4096; h++) historyHeuristic[h] = 0;
})();

var PIECE_VALUE = [0, 100, 320, 330, 500, 900, 20000];

function addMove(idx, from, to, promo, flags) {
	genMoves[idx] = from | (to << 6) | (promo << 12) | (flags << 15);
	var score;
	if (flags & F_CAPTURE) {
		var victim = (flags & F_EP) ? PAWN : (board[to] < 0 ? -board[to] : board[to]);
		var attacker = board[from] < 0 ? -board[from] : board[from];
		score = 1000000 + victim * 10 - attacker;		// most valuable victim, least valuable attacker
	} else if (promo) {
		score = 900000 + promo;
	} else {
		score = historyHeuristic[from * 64 + to];
	}
	if (promo) score += promo * 100;
	genScores[idx] = score;
}

	// generates pseudo legal moves for the side to move; with capturesOnly also promotions
function gen(ply, capturesOnly) {
	var idx = firstMove[ply];
	var us = side;
	var promoRank = (us === WHITE) ? 6 : 1;
	var startRank = (us === WHITE) ? 1 : 6;

	for (var sq = 0; sq < 64; sq++) {
		var p = board[sq];
		if (p === EMPTY || (p > 0) !== (us > 0)) continue;
		var type = p * us;
		var i120 = MAILBOX64[sq];

		if (type === PAWN) {
			var rank = sq >> 3;
			var fwd = sq + 8 * us;
			var d;

			if (board[fwd] === EMPTY) {
				if (rank === promoRank) {
					addMove(idx++, sq, fwd, QUEEN, F_PROMO);
					if (!capturesOnly) {
						addMove(idx++, sq, fwd, ROOK, F_PROMO);
						addMove(idx++, sq, fwd, BISHOP, F_PROMO);
						addMove(idx++, sq, fwd, KNIGHT, F_PROMO);
					}
				} else if (!capturesOnly) {
					addMove(idx++, sq, fwd, 0, 0);
					if (rank === startRank && board[fwd + 8 * us] === EMPTY) {
						addMove(idx++, sq, fwd + 8 * us, 0, F_DOUBLE);
					}
				}
			}

			for (d = -1; d <= 1; d += 2) {
				var t = MAILBOX[i120 + 10 * us + d];
				if (t < 0) continue;
				var q = board[t];
				if (q !== EMPTY && (q > 0) !== (us > 0)) {
					if (rank === promoRank) {
						addMove(idx++, sq, t, QUEEN, F_CAPTURE | F_PROMO);
						if (!capturesOnly) {
							addMove(idx++, sq, t, ROOK, F_CAPTURE | F_PROMO);
							addMove(idx++, sq, t, BISHOP, F_CAPTURE | F_PROMO);
							addMove(idx++, sq, t, KNIGHT, F_CAPTURE | F_PROMO);
						}
					} else {
						addMove(idx++, sq, t, 0, F_CAPTURE);
					}
				} else if (t === ep) {
					addMove(idx++, sq, t, 0, F_CAPTURE | F_EP);
				}
			}
			continue;
		}

		var offs = OFFSETS[type];
		var slide = SLIDES[type];
		for (var o = 0; o < offs.length; o++) {
			var t120 = i120;
			while (true) {
				t120 += offs[o];
				var to = MAILBOX[t120];
				if (to < 0) break;
				var target = board[to];
				if (target === EMPTY) {
					if (!capturesOnly) addMove(idx++, sq, to, 0, 0);
					if (!slide) break;
					continue;
				}
				if ((target > 0) !== (us > 0)) addMove(idx++, sq, to, 0, F_CAPTURE);
				break;
			}
		}
	}

	if (!capturesOnly) {
		if (us === WHITE) {
			if ((castle & 1) && board[5] === EMPTY && board[6] === EMPTY && board[7] === ROOK && board[4] === KING &&
				!attacked(4, BLACK) && !attacked(5, BLACK)) {
				addMove(idx++, 4, 6, 0, F_CASTLE);
			}
			if ((castle & 2) && board[3] === EMPTY && board[2] === EMPTY && board[1] === EMPTY && board[0] === ROOK && board[4] === KING &&
				!attacked(4, BLACK) && !attacked(3, BLACK)) {
				addMove(idx++, 4, 2, 0, F_CASTLE);
			}
		} else {
			if ((castle & 4) && board[61] === EMPTY && board[62] === EMPTY && board[63] === -ROOK && board[60] === -KING &&
				!attacked(60, WHITE) && !attacked(61, WHITE)) {
				addMove(idx++, 60, 62, 0, F_CASTLE);
			}
			if ((castle & 8) && board[59] === EMPTY && board[58] === EMPTY && board[57] === EMPTY && board[56] === -ROOK && board[60] === -KING &&
				!attacked(60, WHITE) && !attacked(59, WHITE)) {
				addMove(idx++, 60, 58, 0, F_CASTLE);
			}
		}
	}

	firstMove[ply + 1] = idx;
}

	// moves the best scored move of genMoves[i .. end - 1] to position i
function pickMove(i, end) {
	var best = i;
	for (var j = i + 1; j < end; j++) {
		if (genScores[j] > genScores[best]) best = j;
	}
	if (best !== i) {
		var m = genMoves[i]; genMoves[i] = genMoves[best]; genMoves[best] = m;
		var s = genScores[i]; genScores[i] = genScores[best]; genScores[best] = s;
	}
}

	// ---------------------------------------------------------------------------------------------
	// making and taking back moves

	// makes the move; returns false (and leaves the position unchanged) when it exposes the own king
function makeMove(m) {
	var from = m & 63;
	var to = (m >> 6) & 63;
	var promo = (m >> 12) & 7;
	var flags = m >> 15;
	var piece = board[from];
	var captured = board[to];
	var us = side;

	undoMove[hply] = m;
	undoCapture[hply] = captured;
	undoCastle[hply] = castle;
	undoEp[hply] = ep;
	undoFifty[hply] = fifty;
	undoHash[hply] = hash;
	hply++;

	if (flags & F_CASTLE) {
		var rookFrom, rookTo;
		if (to === 6) { rookFrom = 7; rookTo = 5; }
		else if (to === 2) { rookFrom = 0; rookTo = 3; }
		else if (to === 62) { rookFrom = 63; rookTo = 61; }
		else { rookFrom = 56; rookTo = 59; }
		var rook = board[rookFrom];
		board[rookFrom] = EMPTY;
		board[rookTo] = rook;
		hash ^= zobPiece[rook + 6][rookFrom] ^ zobPiece[rook + 6][rookTo];
	}

	if (flags & F_EP) {
		var capSq = to - 8 * us;
		hash ^= zobPiece[board[capSq] + 6][capSq];
		board[capSq] = EMPTY;
	}

	hash ^= zobCastle[castle];
	castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
	hash ^= zobCastle[castle];

	if (ep >= 0) hash ^= zobEp[ep];
	ep = (flags & F_DOUBLE) ? from + 8 * us : -1;
	if (ep >= 0) hash ^= zobEp[ep];

	if (captured !== EMPTY || (flags & (F_CAPTURE | F_EP)) || piece === PAWN * us) fifty = 0;
	else fifty++;

	if (captured !== EMPTY) hash ^= zobPiece[captured + 6][to];
	hash ^= zobPiece[piece + 6][from];
	board[from] = EMPTY;
	var placed = promo ? promo * us : piece;
	board[to] = placed;
	hash ^= zobPiece[placed + 6][to];

	if (piece === KING * us) kingSq[us === WHITE ? 0 : 1] = to;

	side = -us;
	hash ^= zobSide;

	if (attacked(kingSq[us === WHITE ? 0 : 1], side)) {
		takeBack();
		return false;
	}
	return true;
}

function takeBack() {
	hply--;
	side = -side;
	var us = side;
	var m = undoMove[hply];
	var from = m & 63;
	var to = (m >> 6) & 63;
	var promo = (m >> 12) & 7;
	var flags = m >> 15;

	var piece = promo ? PAWN * us : board[to];
	board[from] = piece;
	board[to] = undoCapture[hply];
	if (piece === KING * us) kingSq[us === WHITE ? 0 : 1] = from;

	if (flags & F_CASTLE) {
		if (to === 6) { board[7] = board[5]; board[5] = EMPTY; }
		else if (to === 2) { board[0] = board[3]; board[3] = EMPTY; }
		else if (to === 62) { board[63] = board[61]; board[61] = EMPTY; }
		else { board[56] = board[59]; board[59] = EMPTY; }
	}
	if (flags & F_EP) board[to - 8 * us] = -PAWN * us;

	castle = undoCastle[hply];
	ep = undoEp[hply];
	fifty = undoFifty[hply];
	hash = undoHash[hply];
}

	// number of earlier positions (since the last irreversible move) equal to the current one
function repetitions() {
	var r = 0;
	var stop = hply - fifty;
	if (stop < 0) stop = 0;
	for (var i = hply - 2; i >= stop; i -= 2) {
		if (undoHash[i] === hash) r++;
	}
	return r;
}

	// ---------------------------------------------------------------------------------------------
	// game level helpers (used by the user interface)

	// all legal moves in the current position, as an array of move integers
function legalMoves() {
	gen(0, false);
	var moves = [];
	for (var i = firstMove[0]; i < firstMove[1]; i++) {
		if (makeMove(genMoves[i])) {
			takeBack();
			moves.push(genMoves[i]);
		}
	}
	return moves;
}

	// squares the piece on 'from' may move to (each square once, also for the four promotion moves)
function targetsFrom(from) {
	var moves = legalMoves();
	var seen = [];
	var targets = [];
	for (var i = 0; i < moves.length; i++) {
		if ((moves[i] & 63) !== from) continue;
		var to = (moves[i] >> 6) & 63;
		if (!seen[to]) {
			seen[to] = true;
			targets.push(to);
		}
	}
	return targets;
}

	// the legal move from -> to (promoting to 'promo' when relevant), or -1
function findMove(from, to, promo) {
	var moves = legalMoves();
	for (var i = 0; i < moves.length; i++) {
		var m = moves[i];
		if ((m & 63) !== from || ((m >> 6) & 63) !== to) continue;
		if (moveFlags(m) & F_PROMO) {
			if (((m >> 12) & 7) === promo) return m;
		} else {
			return m;
		}
	}
	return -1;
}

	// replays a list of moves from the initial position; throws when a move is not legal
function replay(moves) {
	newGame();
	for (var i = 0; i < moves.length; i++) {
		var m = moves[i];
		var legal = findMove(m & 63, (m >> 6) & 63, (m >> 12) & 7);
		if (legal < 0 || !makeMove(legal)) throw new Error("illegal move in history at " + i);
	}
}

function insufficientMaterial() {
	var minors = [0, 0];
	for (var s = 0; s < 64; s++) {
		var p = board[s];
		if (p === EMPTY) continue;
		var type = p < 0 ? -p : p;
		if (type === PAWN || type === ROOK || type === QUEEN) return false;
		if (type === KNIGHT || type === BISHOP) minors[p > 0 ? 0 : 1]++;
	}
	return minors[0] <= 1 && minors[1] <= 1;
}

function gameResult() {
	if (legalMoves().length === 0) return inCheck() ? CHECKMATE : STALEMATE;
	if (repetitions() >= 2) return DRAW_REPETITION;
	if (fifty >= 100) return DRAW_FIFTY;
	if (insufficientMaterial()) return DRAW_MATERIAL;
	return RUNNING;
}

var PIECE_LETTER_NL = ["", "", "P", "L", "T", "D", "K"];

	// e.g. "e2-e4", "Pg1-f3", "Lc4xf7", "O-O", "e7-e8D"; must be called before the move is made
function moveToString(m) {
	var from = m & 63;
	var to = (m >> 6) & 63;
	var promo = (m >> 12) & 7;
	var flags = m >> 15;
	if (flags & F_CASTLE) return (to === 6 || to === 62) ? "O-O" : "O-O-O";
	var piece = board[from];
	var type = piece < 0 ? -piece : piece;
	var text = PIECE_LETTER_NL[type] + squareName(from) + ((flags & F_CAPTURE) ? "x" : "-") + squareName(to);
	if (promo) text += PIECE_LETTER_NL[promo];
	return text;
}

	// ---------------------------------------------------------------------------------------------
	// evaluation: material plus piece square tables (after Michniewski's simplified evaluation).
	// The tables are written as seen from white's side (first row = rank 8), so a white piece on
	// square s uses index s ^ 56 and a black piece index s.

var PST_PAWN = [
	  0,  0,  0,  0,  0,  0,  0,  0,
	 50, 50, 50, 50, 50, 50, 50, 50,
	 10, 10, 20, 30, 30, 20, 10, 10,
	  5,  5, 10, 25, 25, 10,  5,  5,
	  0,  0,  0, 20, 20,  0,  0,  0,
	  5, -5,-10,  0,  0,-10, -5,  5,
	  5, 10, 10,-20,-20, 10, 10,  5,
	  0,  0,  0,  0,  0,  0,  0,  0
];
var PST_KNIGHT = [
	-50,-40,-30,-30,-30,-30,-40,-50,
	-40,-20,  0,  0,  0,  0,-20,-40,
	-30,  0, 10, 15, 15, 10,  0,-30,
	-30,  5, 15, 20, 20, 15,  5,-30,
	-30,  0, 15, 20, 20, 15,  0,-30,
	-30,  5, 10, 15, 15, 10,  5,-30,
	-40,-20,  0,  5,  5,  0,-20,-40,
	-50,-40,-30,-30,-30,-30,-40,-50
];
var PST_BISHOP = [
	-20,-10,-10,-10,-10,-10,-10,-20,
	-10,  0,  0,  0,  0,  0,  0,-10,
	-10,  0,  5, 10, 10,  5,  0,-10,
	-10,  5,  5, 10, 10,  5,  5,-10,
	-10,  0, 10, 10, 10, 10,  0,-10,
	-10, 10, 10, 10, 10, 10, 10,-10,
	-10,  5,  0,  0,  0,  0,  5,-10,
	-20,-10,-10,-10,-10,-10,-10,-20
];
var PST_ROOK = [
	  0,  0,  0,  0,  0,  0,  0,  0,
	  5, 10, 10, 10, 10, 10, 10,  5,
	 -5,  0,  0,  0,  0,  0,  0, -5,
	 -5,  0,  0,  0,  0,  0,  0, -5,
	 -5,  0,  0,  0,  0,  0,  0, -5,
	 -5,  0,  0,  0,  0,  0,  0, -5,
	 -5,  0,  0,  0,  0,  0,  0, -5,
	  0,  0,  0,  5,  5,  0,  0,  0
];
var PST_QUEEN = [
	-20,-10,-10, -5, -5,-10,-10,-20,
	-10,  0,  0,  0,  0,  0,  0,-10,
	-10,  0,  5,  5,  5,  5,  0,-10,
	 -5,  0,  5,  5,  5,  5,  0, -5,
	  0,  0,  5,  5,  5,  5,  0, -5,
	-10,  5,  5,  5,  5,  5,  0,-10,
	-10,  0,  5,  0,  0,  0,  0,-10,
	-20,-10,-10, -5, -5,-10,-10,-20
];
var PST_KING_MIDDLE = [
	-30,-40,-40,-50,-50,-40,-40,-30,
	-30,-40,-40,-50,-50,-40,-40,-30,
	-30,-40,-40,-50,-50,-40,-40,-30,
	-30,-40,-40,-50,-50,-40,-40,-30,
	-20,-30,-30,-40,-40,-30,-30,-20,
	-10,-20,-20,-20,-20,-20,-20,-10,
	 20, 20,  0,  0,  0,  0, 20, 20,
	 20, 30, 10,  0,  0, 10, 30, 20
];
var PST_KING_END = [
	-50,-40,-30,-20,-20,-30,-40,-50,
	-30,-20,-10,  0,  0,-10,-20,-30,
	-30,-10, 20, 30, 30, 20,-10,-30,
	-30,-10, 30, 40, 40, 30,-10,-30,
	-30,-10, 30, 40, 40, 30,-10,-30,
	-30,-10, 20, 30, 30, 20,-10,-30,
	-30,-30,  0,  0,  0,  0,-30,-30,
	-50,-30,-30,-30,-30,-30,-30,-50
];
var PST = [null, PST_PAWN, PST_KNIGHT, PST_BISHOP, PST_ROOK, PST_QUEEN, null];

	// score of the position from the point of view of the side to move
function evaluate() {
	var score = 0;
	var nonPawn = 0;		// material apart from pawns and kings, decides middle game / endgame

	for (var s = 0; s < 64; s++) {
		var p = board[s];
		if (p === EMPTY) continue;
		if (p > 0) {
			if (p !== KING) {
				score += PIECE_VALUE[p] + PST[p][s ^ 56];
				if (p !== PAWN) nonPawn += PIECE_VALUE[p];
			}
		} else {
			var type = -p;
			if (type !== KING) {
				score -= PIECE_VALUE[type] + PST[type][s];
				if (type !== PAWN) nonPawn += PIECE_VALUE[type];
			}
		}
	}

	var kingTable = (nonPawn <= 2600) ? PST_KING_END : PST_KING_MIDDLE;
	score += kingTable[kingSq[0] ^ 56];
	score -= kingTable[kingSq[1]];

	return (side === WHITE) ? score : -score;
}

	// ---------------------------------------------------------------------------------------------
	// search: negamax with alpha-beta, quiescence search on captures, iterative deepening with a
	// time limit

var nodes = 0;
var stopped = false;
var deadline = 0;
var lastDepth = 0;

function now() {
	return new Date().getTime();
}

function checkTime() {
	nodes++;
	if ((nodes & 1023) === 0 && now() >= deadline) stopped = true;
}

function quiesce(alpha, beta, ply) {
	checkTime();
	if (stopped) return 0;

	var stand = evaluate();
	if (stand >= beta) return beta;
	if (stand > alpha) alpha = stand;
	if (ply >= MAX_PLY - 1) return alpha;

	gen(ply, true);
	var end = firstMove[ply + 1];
	for (var i = firstMove[ply]; i < end; i++) {
		pickMove(i, end);
		if (!makeMove(genMoves[i])) continue;
		var score = -quiesce(-beta, -alpha, ply + 1);
		takeBack();
		if (stopped) return 0;
		if (score >= beta) return beta;
		if (score > alpha) alpha = score;
	}
	return alpha;
}

function negamax(depth, alpha, beta, ply) {
	if (depth <= 0) return quiesce(alpha, beta, ply);

	checkTime();
	if (stopped) return 0;
	if (repetitions() >= 1 || fifty >= 100) return 0;
	if (ply >= MAX_PLY - 1) return evaluate();

	var check = inCheck();
	gen(ply, false);
	var end = firstMove[ply + 1];
	var legal = 0;

	for (var i = firstMove[ply]; i < end; i++) {
		pickMove(i, end);
		var m = genMoves[i];
		if (!makeMove(m)) continue;
		legal++;
		var score = -negamax(depth - 1, -beta, -alpha, ply + 1);
		takeBack();
		if (stopped) return 0;
		if (score > alpha) {
			alpha = score;
			if (alpha >= beta) {
				historyHeuristic[(m & 63) * 64 + ((m >> 6) & 63)] += depth * depth;
				return beta;
			}
		}
	}

	if (legal === 0) return check ? -MATE + ply : 0;
	return alpha;
}

function shuffle(list) {
	for (var i = list.length - 1; i > 0; i--) {
		var j = Math.floor(Math.random() * (i + 1));
		var t = list[i]; list[i] = list[j]; list[j] = t;
	}
}

	// best of 'rootMoves' (all legal) looking at most maxDepth half moves ahead within timeMs
function search(rootMoves, maxDepth, timeMs) {
	nodes = 0;
	stopped = false;
	deadline = now() + timeMs;
	lastDepth = 0;
	for (var h = 0; h < 4096; h++) historyHeuristic[h] = 0;

	shuffle(rootMoves);
	var best = rootMoves[0];

	for (var depth = 1; depth <= maxDepth; depth++) {
		var alpha = -INFINITY;
		var iterBest = -1;

		for (var i = 0; i < rootMoves.length; i++) {
			var m = rootMoves[i];
			makeMove(m);
			var score = -negamax(depth - 1, -INFINITY, -alpha, 1);
			takeBack();
			if (stopped) break;
			if (score > alpha) {
				alpha = score;
				iterBest = m;
			}
		}

			// a move found in an interrupted iteration is still better informed than the previous one
		if (iterBest !== -1) {
			best = iterBest;
			for (var k = 0; k < rootMoves.length; k++) {
				if (rootMoves[k] === best) {
					rootMoves[k] = rootMoves[0];
					rootMoves[0] = best;
					break;
				}
			}
		}
		if (stopped) break;
		lastDepth = depth;
		if (alpha > MATE - MAX_PLY || alpha < -MATE + MAX_PLY) break;	// forced mate found, no need to look further
		if (now() - (deadline - timeMs) > timeMs / 2) break;			// the next iteration will not finish in time
	}
	return best;
}

	// depth 1 search that scores every move, then picks one at random among the reasonable ones
function easyMove(rootMoves) {
	nodes = 0;
	stopped = false;
	deadline = now() + 3000;
	var scores = [];
	var bestScore = -INFINITY;

	for (var i = 0; i < rootMoves.length; i++) {
		makeMove(rootMoves[i]);
		scores[i] = -quiesce(-INFINITY, INFINITY, 1);
		takeBack();
		if (scores[i] > bestScore) bestScore = scores[i];
	}

	var candidates = [];
	for (var j = 0; j < rootMoves.length; j++) {
		if (scores[j] >= bestScore - 80) candidates.push(rootMoves[j]);
	}
	lastDepth = 1;
	return candidates[Math.floor(Math.random() * candidates.length)];
}

function levelName(level) {
	switch (level) {
		case LEVEL_EASY: return "Makkelijk";
		case LEVEL_HARD: return "Moeilijk";
		default: return "Normaal";
	}
}

	// the computer's move for the given level, or -1 when there is no legal move
function chooseMove(level) {
	var moves = legalMoves();
	if (moves.length === 0) return -1;
	if (moves.length === 1) return moves[0];

	switch (level) {
		case LEVEL_EASY: return easyMove(moves);
		case LEVEL_HARD: return search(moves, 5, 4000);
		default: return search(moves, 3, 1500);
	}
}

	// start with a valid position, so getBoard() never hands out an empty array
newGame();
