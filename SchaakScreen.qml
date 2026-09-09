import QtQuick 2.1
import qb.components 1.0

Screen {
	id: schaakScreen

	screenTitle: "Schaken"
	screenTitleIconUrl: "qrc:/tsc/schaak.png"

	property int cellSize : isNxt ? 58 : 44
	property int pieceSize : isNxt ? 52 : 40
	property int panelWidth : isNxt ? 458 : 366
	property int buttonWidth : (panelWidth - 10) / 2

		// the human's pieces are always at the bottom
	property bool flipped : app.humanColor === app.black

	property color lightSquare : "#f0d9b5"
	property color darkSquare : "#b58863"
	property color frameColor : "#5d4037"
	property color selectColor : "#99f7ec3f"
	property color lastMoveColor : "#66cddc39"
	property color checkColor : "#99e53935"
	property color textColor : "#565656"

		// board square (0 = a1) shown in the i-th cell of the grid, counted from the top left
	function squareAt(i) {
		var row = Math.floor(i / 8);
		var col = i % 8;
		return flipped ? row * 8 + (7 - col) : (7 - row) * 8 + col;
	}

	// the board

	Rectangle {
		id: boardFrame
		width: 8 * cellSize + 4
		height: width
		color: frameColor
		anchors {
			top: parent.top
			topMargin: isNxt ? 16 : 12
			left: parent.left
			leftMargin: isNxt ? 32 : 24
		}

		Grid {
			id: boardGrid
			columns: 8
			anchors.centerIn: parent

			Repeater {
				model: 64

				Item {
					width: cellSize
					height: cellSize
					property int sq : squareAt(index)
					property int piece : app.board[sq]
					property bool isTarget : app.legalTargets.indexOf(sq) >= 0
					property bool kingInCheck : app.inCheck && piece === app.kingPiece * app.sideToMove

					Rectangle {
						anchors.fill: parent
						color: (((sq >> 3) + (sq & 7)) % 2 === 1) ? lightSquare : darkSquare
					}

						// selected piece, last move and a king in check
					Rectangle {
						anchors.fill: parent
						visible: sq === app.selectedSquare || sq === app.lastFrom || sq === app.lastTo || kingInCheck
						color: (sq === app.selectedSquare) ? selectColor : (kingInCheck ? checkColor : lastMoveColor)
					}

						// a dot on empty squares the selected piece can move to, a ring around pieces it can take
					Rectangle {
						anchors.centerIn: parent
						width: cellSize / 3
						height: width
						radius: width / 2
						color: "#55000000"
						visible: isTarget && piece === 0
					}
					Rectangle {
						anchors.fill: parent
						color: "transparent"
						border.width: isNxt ? 5 : 4
						border.color: "#77000000"
						visible: isTarget && piece !== 0
					}

					Image {
						anchors.centerIn: parent
						source: app.pieceSource(piece)
						sourceSize.width: pieceSize
						sourceSize.height: pieceSize
						visible: piece !== 0
					}
				}
			}
		}

			// one touch area for the whole board is cheaper than one per square
		MouseArea {
			anchors.fill: boardGrid
			onClicked: {
				var col = Math.floor(mouse.x / cellSize);
				var row = Math.floor(mouse.y / cellSize);
				if (col < 0 || col > 7 || row < 0 || row > 7) return;
				app.squareTapped(squareAt(row * 8 + col));
			}
		}
	}

	// status and controls to the right of the board

	Text {
		id: statusText
		text: app.statusText
		color: textColor
		width: panelWidth
		elide: Text.ElideRight
		anchors {
			top: boardFrame.top
			topMargin: isNxt ? 4 : 2
			left: boardFrame.right
			leftMargin: isNxt ? 40 : 30
		}
		font {
			family: qfont.bold.name
			pixelSize: isNxt ? 26 : 21
		}
	}

	Text {
		id: lastMoveText
		text: (app.lastMoveText.length > 0) ? "Laatste zet: " + app.lastMoveText : "Nog geen zet gedaan"
		color: textColor
		anchors {
			top: statusText.bottom
			topMargin: isNxt ? 8 : 6
			left: statusText.left
		}
		font {
			family: qfont.regular.name
			pixelSize: isNxt ? 18 : 15
		}
	}

	Text {
		id: legendText
		text: (app.humanColor === app.white) ? "Jij speelt wit, Toon speelt zwart" : "Jij speelt zwart, Toon speelt wit"
		color: textColor
		anchors {
			top: lastMoveText.bottom
			topMargin: isNxt ? 8 : 6
			left: statusText.left
		}
		font {
			family: qfont.regular.name
			pixelSize: isNxt ? 18 : 15
		}
	}

	Rectangle {
		id: scoreRect
		width: panelWidth
		height: isNxt ? 56 : 46
		radius: 3
		color: "#f0f0f0"
		anchors {
			top: legendText.bottom
			topMargin: isNxt ? 20 : 14
			left: statusText.left
		}

		Text {
			anchors.centerIn: parent
			text: "Jij " + app.wins + "  -  Toon " + app.losses + "  -  Remise " + app.draws
			color: textColor
			font {
				family: qfont.semiBold.name
				pixelSize: isNxt ? 22 : 18
			}
		}
	}

	StandardButton {
		id: btnNewGame
		width: buttonWidth
		text: "Nieuw spel"
		anchors {
			top: scoreRect.bottom
			topMargin: isNxt ? 20 : 14
			left: scoreRect.left
		}
		onClicked: app.newGame()
	}

	StandardButton {
		id: btnUndo
		width: buttonWidth
		text: "Zet terug"
		enabled: app.gameState === app.running && app.moveHistory.length > 0
		anchors {
			top: btnNewGame.top
			left: btnNewGame.right
			leftMargin: 10
		}
		onClicked: app.undoMove()
	}

	StandardButton {
		id: btnLevel
		width: buttonWidth
		text: "Niveau: " + app.levelName
		anchors {
			top: btnNewGame.bottom
			topMargin: 10
			left: scoreRect.left
		}
		onClicked: app.cycleLevel()
	}

	StandardButton {
		id: btnColour
		width: buttonWidth
		text: app.humanPlaysWhite ? "Volgend spel: wit" : "Volgend spel: zwart"
		anchors {
			top: btnLevel.top
			left: btnLevel.right
			leftMargin: 10
		}
		onClicked: app.toggleColour()
	}

	StandardButton {
		id: btnResetScore
		width: buttonWidth
		text: "Score wissen"
		anchors {
			top: btnLevel.bottom
			topMargin: 10
			left: scoreRect.left
		}
		onClicked: app.resetScore()
	}
}
