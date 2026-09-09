import QtQuick 2.1
import qb.components 1.0
import qb.base 1.0
import FileIO 1.0
import "schaak.js" as Chess

App {
	id: schaakApp
	objectName: "SchaakApp"

	property url tileUrl : "SchaakTile.qml"
	property url thumbnailIcon: "qrc:/tsc/schaak.png"
	property url screenUrl : "SchaakScreen.qml"
	property SchaakScreen schaakScreen

		// piece codes as used in schaak.js, for the screen and the tile
	readonly property int white : Chess.WHITE
	readonly property int black : Chess.BLACK
	readonly property int kingPiece : Chess.KING
	readonly property int running : Chess.RUNNING

		// the position as shown to the user: 64 signed piece codes, index 0 = a1, 7 = h1, 56 = a8 (see schaak.js).
		// schaak.js holds the real game state; these properties are copies so QML bindings update.
	property var board : Chess.getBoard()
	property int sideToMove : Chess.WHITE
	property int humanColor : Chess.WHITE		// colour the human plays in the current game
	property int gameState : Chess.RUNNING
	property bool inCheck : false
	property bool computerThinking : false
	property int selectedSquare : -1
	property var legalTargets : []				// squares the selected piece may move to
	property int lastFrom : -1
	property int lastTo : -1
	property string lastMoveText : ""
	property var moveHistory : []				// all moves of the current game, as move integers

		// settings and score, kept in the user settings file
	property int level : Chess.LEVEL_NORMAL
	property bool humanPlaysWhite : true		// applies to the next game
	property int wins : 0
	property int losses : 0
	property int draws : 0

	property string levelName : Chess.levelName(level)
	property bool humanTurn : gameState === Chess.RUNNING && !computerThinking && sideToMove === humanColor

	property string statusText : {
		if (gameState === Chess.CHECKMATE) return (sideToMove === humanColor) ? "Schaakmat, Toon heeft gewonnen" : "Schaakmat, je hebt gewonnen!";
		if (gameState === Chess.STALEMATE) return "Pat, gelijkspel";
		if (gameState === Chess.DRAW_REPETITION) return "Remise door zetherhaling";
		if (gameState === Chess.DRAW_FIFTY) return "Remise, vijftig zetten regel";
		if (gameState === Chess.DRAW_MATERIAL) return "Remise, te weinig materiaal";
		if (computerThinking) return "Toon denkt na...";
		return inCheck ? "Schaak! Jouw beurt" : "Jouw beurt";
	}

	readonly property string settingsFilePath : "file:///mnt/data/tsc/schaak.userSettings.json"

		// the search runs in a worker thread so the screen stays responsive; 'searchSeq' numbers the
		// requests, so a reply to a search that was cancelled by a new game or undo is ignored
	property int searchSeq : 0
	property bool workerBroken : false			// once the worker failed, the search runs in this thread instead

	FileIO {
		id: settingsFile
		source: settingsFilePath
	}

	WorkerScript {
		id: engineWorker
		source: "schaakWorker.js"
		onMessage: engineReply(messageObject)
	}

	function init() {
		registry.registerWidget("tile", tileUrl, this, null, {thumbLabel: "Schaken", thumbIcon: thumbnailIcon, thumbCategory: "general", thumbWeight: 30, baseTileWeight: 10, thumbIconVAlignment: "center"});
		registry.registerWidget("screen", screenUrl, this, "schaakScreen");
	}

	Component.onCompleted: {
		var savedGame = loadSettings();
		if (!savedGame || !restoreGame(savedGame)) newGame();
	}

		// returns the saved game (moves and colour), or null when there is none
	function loadSettings() {
		var savedGame = null;
		try {
			var settings = JSON.parse(settingsFile.read());
			if (settings['level']) level = settings['level'];
			if (typeof settings['humanPlaysWhite'] === 'boolean') humanPlaysWhite = settings['humanPlaysWhite'];
			if (settings['wins']) wins = settings['wins'];
			if (settings['losses']) losses = settings['losses'];
			if (settings['draws']) draws = settings['draws'];
			if (settings['game'] && settings['game']['moves']) savedGame = settings['game'];
		} catch(e) {
			// no settings file yet: keep the defaults
		}
		return savedGame;
	}

		// the game in progress is saved as well, so it survives a restart of the Toon interface
	function saveSettings() {
		var tmpUserSettingsJson = {
			"level": level,
			"humanPlaysWhite": humanPlaysWhite,
			"wins": wins,
			"losses": losses,
			"draws": draws,
			"game": {
				"humanColor": humanColor,
				"moves": moveHistory
			}
		}

		var saveFile = new XMLHttpRequest();
		saveFile.open("PUT", settingsFilePath);
		saveFile.send(JSON.stringify(tmpUserSettingsJson));
	}

	function restoreGame(savedGame) {
		try {
			var moves = savedGame['moves'];
			Chess.replay(moves);
			humanColor = (savedGame['humanColor'] === Chess.BLACK) ? Chess.BLACK : Chess.WHITE;
			moveHistory = moves.slice();
			setLastMove(moves);
			syncFromEngine();
			if (gameState === Chess.RUNNING && sideToMove !== humanColor) startComputerMove();
			return true;
		} catch(e) {
			console.log("Schaak: could not restore the saved game: " + e);
			return false;
		}
	}

		// copies the state of the engine into the properties the screen and tile are bound to
	function syncFromEngine() {
		board = Chess.getBoard();
		sideToMove = Chess.side;
		inCheck = Chess.inCheck();
		gameState = Chess.gameResult();
		selectedSquare = -1;
		legalTargets = [];
	}

		// last move highlight and text for a position reached by replaying 'moves'
	function setLastMove(moves) {
		if (moves.length === 0) {
			lastFrom = -1;
			lastTo = -1;
			lastMoveText = "";
			return;
		}
		var last = moves[moves.length - 1];
		Chess.takeBack();
		lastMoveText = Chess.moveToString(last);
		Chess.makeMove(last);
		lastFrom = Chess.moveFrom(last);
		lastTo = Chess.moveTo(last);
	}

	function newGame() {
		cancelSearch();
		humanColor = humanPlaysWhite ? Chess.WHITE : Chess.BLACK;
		Chess.newGame();
		moveHistory = [];
		setLastMove(moveHistory);
		syncFromEngine();
		saveSettings();
		if (sideToMove !== humanColor) startComputerMove();
	}

		// called from the screen: first tap selects a piece, second tap moves it
	function squareTapped(sq) {
		if (!humanTurn) return;

		var piece = board[sq];
		var ownPiece = (piece !== 0) && ((piece > 0) === (humanColor > 0));

		if (sq === selectedSquare) {
			selectedSquare = -1;
			legalTargets = [];
			return;
		}
		if (ownPiece) {
			selectedSquare = sq;
			legalTargets = Chess.targetsFrom(sq);
			return;
		}
		if (selectedSquare < 0) return;

			// a pawn reaching the last rank always becomes a queen
		var move = Chess.findMove(selectedSquare, sq, Chess.QUEEN);
		selectedSquare = -1;
		legalTargets = [];
		if (move < 0) return;

		playMove(move);
		if (gameState === Chess.RUNNING) startComputerMove();
	}

		// plays a legal move on the board, updates the game state and the score
	function playMove(move) {
		var text = Chess.moveToString(move);
		if (!Chess.makeMove(move)) return;

		lastMoveText = text;
		lastFrom = Chess.moveFrom(move);
		lastTo = Chess.moveTo(move);

			// work on a copy: mutating the array in place would not change the property's
			// value reference, so QML would emit no change signal
		var history = moveHistory.slice();
		history.push(move);
		moveHistory = history;

		syncFromEngine();

		if (gameState === Chess.CHECKMATE) {
			if (sideToMove === humanColor) losses++;
			else wins++;
		} else if (gameState !== Chess.RUNNING) {
			draws++;
		}
		saveSettings();
	}

	function startComputerMove() {
		computerThinking = true;
		searchSeq++;
		if (workerBroken) {
			thinkTimer.start();
			return;
		}
		engineWorker.sendMessage({"seq": searchSeq, "level": level, "moves": moveHistory});
		watchdog.start();
	}

	function engineReply(reply) {
		if (reply.seq !== searchSeq) return;		// answer to a search that was cancelled
		watchdog.stop();
		if (reply.error) {
			console.log("Schaak: engine worker failed (" + reply.error + "), searching in the interface thread instead");
			workerBroken = true;
			thinkTimer.start();
			return;
		}
		computerThinking = false;
		if (reply.move >= 0) playMove(reply.move);
	}

		// fallback when the worker is not available: search in this thread. The short delay lets the
		// screen show "Toon denkt na..." first.
	function computerMoveInline() {
		var move = Chess.chooseMove(level);
		computerThinking = false;
		if (move >= 0) playMove(move);
	}

	function cancelSearch() {
		searchSeq++;
		watchdog.stop();
		thinkTimer.stop();
		computerThinking = false;
	}

		// takes back the last move of the human (and Toon's reply, if any)
	function undoMove() {
		if (gameState !== Chess.RUNNING || moveHistory.length === 0) return;
		cancelSearch();

		var history = moveHistory.slice();
		try {
			do {
				history.pop();
				Chess.replay(history);
			} while (history.length > 0 && Chess.side !== humanColor);
		} catch(e) {
			console.log("Schaak: could not take back a move: " + e);
			newGame();
			return;
		}
		moveHistory = history;
		setLastMove(history);
		syncFromEngine();
		saveSettings();
	}

	function cycleLevel() {
		level = (level >= Chess.LEVEL_HARD) ? Chess.LEVEL_EASY : level + 1;
		saveSettings();
	}

		// applies to the next game
	function toggleColour() {
		humanPlaysWhite = !humanPlaysWhite;
		saveSettings();
	}

	function resetScore() {
		wins = 0;
		losses = 0;
		draws = 0;
		saveSettings();
	}

		// image for a piece code, relative to the app directory; "" for an empty square
	function pieceSource(piece) {
		if (!piece) return "";
		var names = ["", "p", "n", "b", "r", "q", "k"];
		return "drawables/" + (piece > 0 ? "w" : "b") + names[piece > 0 ? piece : -piece] + ".png";
	}

	Timer {
		id: thinkTimer
		interval: 300
		running: false
		repeat: false
		onTriggered: computerMoveInline()
	}

		// the hardest level thinks about 4 seconds; if the worker has not answered long after that,
		// something is wrong with it and the search is done in this thread from then on
	Timer {
		id: watchdog
		interval: 20000
		running: false
		repeat: false
		onTriggered: {
			console.log("Schaak: no answer from the engine worker, searching in the interface thread instead");
			workerBroken = true;
			searchSeq++;
			thinkTimer.start();
		}
	}
}
