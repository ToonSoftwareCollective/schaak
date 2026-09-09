	// Runs the computer's move search in a worker thread, so the Toon screen stays responsive
	// while Toon thinks. Receives {seq, level, moves} and answers {seq, move, depth, nodes},
	// or {seq, error} when something went wrong (SchaakApp then searches in its own thread).

var included = Qt.include("schaak.js");

WorkerScript.onMessage = function(message) {
	if (included.status !== 0 && included.status !== included.OK) {
		WorkerScript.sendMessage({"seq": message.seq, "error": "could not load schaak.js: " + included.exception});
		return;
	}

	var move = -1;
	try {
		replay(message.moves);
		move = chooseMove(message.level);
	} catch (e) {
		WorkerScript.sendMessage({"seq": message.seq, "error": String(e)});
		return;
	}
	WorkerScript.sendMessage({"seq": message.seq, "move": move, "depth": lastDepth, "nodes": nodes});
}
