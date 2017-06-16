const path = require("path");
const electron = require("electron");
const ipc = electron.ipcRenderer;
const _ = require("lodash");
const {filter, wrap} = require("fuzzaldrin-plus");

const $ = window.jQuery = require('./jquery-2.2.3.min.js');

const InkProject = require("./inkProject.js").InkProject;

var $goto = null;
var $gotoContainer = null;
var $input = null;
var $results = null;

var $selectedResult = null;

var lastMousePos = null;

var cachedFiles = null;
var cachedSymbols = null;
var cachedLineGroups = null;
const linesPerGroup = 20000;

var resultsBuildInterval = null;

var events = {
    gotoFile: () => {}
};

function show() {
    $goto.removeClass("hidden");
    $gotoContainer.removeClass("ignore-events");
    $input.val("");

    select(null);

    setTimeout(() => $input.focus(), 200);

    $(document).on("keydown", gotoGlobalKeyHandler);

    // Collect all files
    var files = InkProject.currentProject.files;
    cachedFiles = _.map(files, file => ({
        name: file.filename(),
        file: file
    }));

    // Collect all symbols
    var allSymbols = [];
    for(var i=0; i<files.length; i++) {
        var file = files[i];
        var fileSymbols = file.symbols.getSymbols();

        var recurse = file == InkProject.currentProject.activeInkFile;
        collectSymbols(allSymbols, fileSymbols, recurse);
    }
    cachedSymbols = allSymbols;

    // Collect individual lines of all files
    cachedLineGroups = [];
    var currentLines = [];
    for(var i=0; i<files.length; i++) {
        var file = files[i];
        var lines = file.getValue().split("\n");
        for(var row=0; row<lines.length; row++) {
            var line = lines[row];
            currentLines.push({
                line: line,
                lineLower: line.toLowerCase(),
                row: row,
                file: file
            });
            if( currentLines.length > linesPerGroup ) {
                cachedLineGroups.push(currentLines);
                currentLines = [];
            }
        }
    }
    cachedLineGroups.push(currentLines);
}

function collectSymbols(allSymbols, symbolsObj, recurse)
{
    var symbols = _.values(symbolsObj);
    allSymbols.push.apply(allSymbols, symbols);

    if( !recurse ) return;

    for(var j=0; j<symbols.length; j++) {
        var sym = symbols[j];
        if( sym.innerSymbols )
            collectSymbols(allSymbols, sym.innerSymbols, recurse);
    }
}

function hide() {
    $(document).off("keydown", gotoGlobalKeyHandler);

    $goto.addClass("hidden");
    $gotoContainer.addClass("ignore-events");
}

function toggle() {
    if( $goto.hasClass("hidden") )
        show();
    else
        hide();
}

function refresh() {

    var searchStr = $input.val();

    $results.empty();

    select(null);

    if( !searchStr ) return;

    // Cancel previous build of results
    if( resultsBuildInterval != null ) {
        clearInterval(resultsBuildInterval);
        resultsBuildInterval = null;
    }

    $results.scrollTop(0);

    var fileResults = filter(cachedFiles, searchStr, {key: "name"});
    var symResults = filter(cachedSymbols, searchStr, {key: "name"});

    var results = _.union(fileResults, symResults);
    
    // Spread the rendering of the results over multiple frames
    // so that we don't have one big hit when there are lots of results.
    const buildInterval = 35;           // add more every X ms
    const maxResultsPerInterval = 10;   // how many results to add each interval

    var currentResultIdx = 0;
    var currentLineGroupIdx = 0;

    var resultBuildTick = () => {

        // Search the text of more lines?
        if( currentLineGroupIdx < cachedLineGroups.length ) {
            var linesToSearch = cachedLineGroups[currentLineGroupIdx];
            var searchStrLower = searchStr.toLowerCase();
            for(var i=0; i<linesToSearch.length; i++) {
                var line = linesToSearch[i];
                if( line.lineLower.indexOf(searchStrLower) != -1 )
                    results.push(line);
            }
            currentLineGroupIdx++;
        }

        // Render more results?
        var maxResultIdxToRenderNow = Math.min(results.length, currentResultIdx+maxResultsPerInterval) - 1;
        while(currentResultIdx <= maxResultIdxToRenderNow) {
            addResult(results[currentResultIdx], searchStr);
            currentResultIdx++;
        }

        // Done building results?
        const maxEverResults = 1000;
        if( currentResultIdx >= results.length-1 && currentLineGroupIdx >= cachedLineGroups.length || currentResultIdx >= maxEverResults ) {
            clearInterval(resultsBuildInterval);
            resultsBuildInterval = null;
        }
    };

    // Run the first build tick immediately to fill up the view
    resultBuildTick();
    resultsBuildInterval = setInterval(resultBuildTick, buildInterval);
}

function addResult(result, searchStr)
{
    var resultContent = result.name || result.line;

    var wrappedResult = wrap(resultContent, searchStr, { wrap: {
        tagOpen: "<span class='goto-highlight'>",
        tagClose: "</span>"
    }});



    var type = resultType(result);
    var $result;

    if( type == "file" ) {
        var dirStr = "";
        var file = result.file;
        var dirName = path.dirname(file.relativePath());
        if( dirName != "." )
            dirStr = `<span class='ancestor'>${dirName}/</span>`;
        $result = $(`<li class='file'>📄 ${dirStr}${wrappedResult}</li>`);
    }

    else if( type == "symbol" ) {
        var ancestorStr = "";
        var ancestor = result.parent
        while(ancestor && ancestor.name) {
            ancestorStr = ancestor.name + "." + ancestorStr;
            ancestor = ancestor.parent;
        }
        if( ancestorStr )
            ancestorStr = `<span class='ancestor'>${ancestorStr}</span>`;

        var filePath = result.inkFile.relativePath();
        $result = $(`<li class='symbol'><p>✎ ${ancestorStr}${wrappedResult}</p><p class='meta'>${filePath}</p></li>`);
    }

    else if( type == "content" ) {
        var filePath = result.file.relativePath();
        $result = $(`<li class='content'><p>${wrappedResult}</p><p class='meta'>${filePath}</p></li>`);
    }

    $result.data("result", result);
    $result.on("click", result, () => choose($result));
    $result.on("mousemove", (e) => {
        // Only mouse-over something if it's really the mouse that moved rather than
        // just the document scrolling under the mouse.
        if( lastMousePos == null || lastMousePos.pageX != e.pageX || lastMousePos.pageY != e.pageY ) {
            lastMousePos = { pageX: e.pageX, pageY: e.pageY };
            select($result);
        }
    });
    $results.append($result);
}

function select($result)
{
    if( $selectedResult != null )
        $selectedResult.removeClass("selected");

    $selectedResult = $result;

    if( $selectedResult != null )
        $selectedResult.addClass("selected");
}

function resultType(result)
{
    // Text content of line result
    if( typeof result.line !== 'undefined' )
        return "content";

    // File name
    if( result.file )
        return "file";

    // Symbol
    else if( typeof result.row !== 'undefined' )
        return "symbol";

    return null;
}

function choose($result)
{
    var result = $result.data().result;
    var type = resultType(result);

    // Text content of line result
    if( type == "content" )
        events.gotoFile(result.file, result.row);

    // File name
    if( type == "file" )
        events.gotoFile(result.file);

    // Symbol
    else if( type == "symbol" )
        events.gotoFile(result.inkFile, result.row);

    // done!
    hide();
}

function nextResult() {

    // Select very first (after input being active)
    if( $selectedResult == null ) {
        var $first = $results.children("li").first();
        if( $first.length > 0 )
            select($first);
        $input.blur();
        return;
    }

    var $next = $selectedResult.next();
    if( $next.length > 0 )
        select($next);
}

function previousResult() {
    if( $selectedResult == null ) return;
    var $prev = $selectedResult.prev();
    if( $prev.length > 0 )
        select($prev);
}

function scrollToRevealResult() {
    if( $selectedResult != null ) {
        var $container = $selectedResult.parent();
        var top = $container.offset().top;
        var bottom = top + $container.height();
        var mid = 0.5 * (top + bottom);

        var currPos = $selectedResult.offset().top;
        if( currPos < top || currPos+$selectedResult.height() > bottom ) {
            $selectedResult[0].scrollIntoView(currPos < mid);
        }
    }
}

function gotoGlobalKeyHandler(e) {

    // down
    if( e.keyCode == 40 ) {
        nextResult();
        scrollToRevealResult();
        e.preventDefault();
    } 

    // up
    else if( e.keyCode == 38 ) {
        previousResult();
        scrollToRevealResult();
        e.preventDefault();
    }

    // return
    else if( e.keyCode == 13 ) {
        if( $selectedResult != null )
            choose($selectedResult);
    }

    // escape
    else if( e.keyCode == 27 ) {
        hide();
    }
}

$(document).ready(() => {
    $goto = $("#goto-anything");
    $gotoContainer = $("#goto-anything-container");
    $input = $goto.children("input");
    $results = $goto.children(".results");
    $input.on("input", refresh);
    $input.on("focus", () => select(null));

    $gotoContainer.on("click", () => hide());

    // Some other events are handled global document handler
    $input.on("keydown", (e) => {
        if( e.keyCode == 13 ) {
            nextResult();
            e.preventDefault();
        }
    });
});

ipc.on("goto-anything", (event) => {
    toggle();
});

exports.GotoAnything = {
    setEvents: e => events = e,
}