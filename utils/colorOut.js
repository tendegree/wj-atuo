/**
 * 彩色控制台输出
 * 使用 Node.js 内置模块，无外部依赖。
 */

function basePrint(color, msg) {
  console.log(`${color}%s\x1B[0m`, msg)
}

function printRed(msg) {
  basePrint("\x1B[31m", msg)
}

function printGreen(msg) {
  basePrint("\x1B[32m", msg)
}

function printYellow(msg) {
  basePrint("\x1B[33m", msg)
}

function printBlue(msg) {
  basePrint("\x1B[34m", msg)
}

function printMagenta(msg) {
  basePrint("\x1B[35m", msg)
}

function printGrey(msg) {
  basePrint("\x1B[2m", msg)
}

module.exports = {
  printGreen, printBlue, printRed, printYellow, printMagenta, printGrey
}