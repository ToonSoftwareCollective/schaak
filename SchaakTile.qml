import QtQuick 2.1
import qb.components 1.0

Tile {
	id: schaakTile

	property bool dimState: screenStateController.dimmedColors
	property int miniCell : isNxt ? 15 : 11
	property bool flipped : app.humanColor === app.black

	onClicked: {
		if (app.schaakScreen) app.schaakScreen.show();
	}

	function squareAt(i) {
		var row = Math.floor(i / 8);
		var col = i % 8;
		return flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col;
	}

	Text {
		id: tileTitle
		text: app.computerThinking ? "Toon denkt na..." : "Schaken"
		anchors {
			baseline: parent.top
			baselineOffset: isNxt ? 32 : 25
			horizontalCenter: parent.horizontalCenter
		}
		font {
			family: qfont.bold.name
			pixelSize: isNxt ? 22 : 18
		}
		color: (typeof dimmableColors !== 'undefined') ? dimmableColors.clockTileColor : colors.clockTileColor
	}

		// small copy of the board; hidden in dim mode so it does not light up the room at night

	Rectangle {
		id: miniBoard
		width: 8 * miniCell + 2
		height: width
		color: "#5d4037"
		visible: !dimState
		anchors {
			top: tileTitle.baseline
			topMargin: isNxt ? 12 : 9
			horizontalCenter: parent.horizontalCenter
		}

		Grid {
			columns: 8
			anchors.centerIn: parent

			Repeater {
				model: 64

				Item {
					width: miniCell
					height: miniCell
					property int sq : squareAt(index)
					property int piece : app.board[sq]

					Rectangle {
						anchors.fill: parent
						color: (((sq >> 3) + (sq & 7)) % 2 === 1) ? "#f0d9b5" : "#b58863"
					}

					Image {
						anchors.centerIn: parent
						source: app.pieceSource(piece)
						sourceSize.width: miniCell - 1
						sourceSize.height: miniCell - 1
						visible: piece !== 0
					}
				}
			}
		}
	}

	Text {
		id: tileScore
		text: "Jij " + app.wins + " - Toon " + app.losses + " - Remise " + app.draws
		anchors {
			baseline: parent.bottom
			baselineOffset: isNxt ? -14 : -12
			horizontalCenter: parent.horizontalCenter
		}
		font {
			family: qfont.regular.name
			pixelSize: isNxt ? 18 : 15
		}
		color: (typeof dimmableColors !== 'undefined') ? dimmableColors.clockTileColor : colors.clockTileColor
	}
}
