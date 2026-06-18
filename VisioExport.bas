Attribute VB_Name = "VisioExport"
'==============================================================================
' RIDESIM EXPORTER FOR VISIO
'------------------------------------------------------------------------------
' Reads the ACTIVE PAGE and emits the three JSON blocks the Ride Sequence
' Planner expects (nodes, connections, attractions). Walking lines are read as
' polylines so their real bent shape drives length + animation.
'
' HOW TO USE
'   1. Alt+F11 in Visio -> File > Import File... > pick VisioExport.bas
'      (or paste this whole module into a new Module).
'   2. Build your drawing with the four masters named exactly:
'         Node       - a path junction (isAttraction = false)
'         Entrance   - an attraction entrance node (isAttraction = true)
'         Exit       - an attraction exit node     (isAttraction = true)
'         Attraction - the attraction label/marker (carries name + ride length)
'   3. Wire it up with glued lines (center glue point to center glue point):
'        - WALKWAY graph: lines between Node / Entrance / Exit shapes. Bend them
'          however you like - bends are captured as polylines.
'        - ASSOCIATION: from each Attraction shape, draw one line to its
'          Entrance node and one line to its Exit node. These tell the exporter
'          which entrance/exit belong to the attraction and are NOT walkway
'          edges. An Attraction must connect ONLY to Entrance/Exit shapes -
'          never directly into the walkway graph.
'   4. Run:  Tools > Macros > VisioExport.ExportRideSim   (or F5 in the editor).
'   5. The macro writes the data straight into index.html, replacing the text
'      between the // @RIDESIM:*:START / :END markers (the three SAMPLE arrays).
'      It looks for index.html next to the saved .vsdx; set HTML_PATH_OVERRIDE
'      below to point elsewhere. Just refresh the browser afterwards.
'      If index.html / its markers aren't found, it falls back to writing
'      "ridesim_export.txt" for manual paste. Output also goes to Ctrl+G.
'
' AUTO-NAMING (no shape data needed - just set shape TEXT):
'   Attraction : id = sanitized attraction TEXT (e.g. "Pirates" -> pirates).
'   Entrance   : id = <attractionId>_in   (taken from its association line).
'   Exit       : id = <attractionId>_out.
'   Node       : set its TEXT to the LAND it sits in (e.g. "Adventureland").
'                id = <land><n>, numbered left->right then bottom->top
'                (e.g. adventureland1, adventureland2 ...). Blank text -> node1..
'                A Node whose TEXT is "Start" gets id "start" and is used as the
'                planner's starting location (where the day begins).
'   Ids are forced unique; a clash gets _2, _3 appended.
'
' OPTIONAL SHAPE DATA (Shape Data / Custom Properties) - all override the above:
'   On any shape:        Prop.ID          -> use this exact id instead of auto
'                        Prop.Name        -> JSON "name" (else omitted for nodes)
'   On Attraction:       Prop.RideDuration-> ride minutes (else DEFAULT_RIDE).
'                        Also accepts Prop.Duration / RideTime / Ride / Minutes,
'                        numeric or text ("12 min").
'
' SCALE BAR (sets real-world walking speed):
'   Add two shapes named (or mastered) ScaleStart and ScaleEnd and a line
'   between them; put the real distance in FEET as the line's text (e.g. "350").
'   The exporter writes feet-per-pixel = feet / pixel-distance into
'   SAMPLE.feetPerPixel, which fills the planner's ft/px box. (Distance text may
'   instead sit on ScaleStart/ScaleEnd if you prefer.)
'
' BACKGROUND MAP
'   Put your map image on a layer named "Bck" (Home > Layers) and draw the nodes
'   over it. The exporter writes that shape's bounding box as SAMPLE.mapExtent,
'   and the planner stretches background.png to exactly that rectangle - so any
'   image resolution lines up automatically (no manual aligning). Export the
'   same image as background.png next to index.html.
'
' COORDINATES
'   Visio is inches, origin bottom-left, Y up. We emit pixels, origin top-left,
'   Y down (screen space). Node coords are relative to the Bck map extent, so
'   PPI only sets overall resolution (any value works; Visio default = 96).
'==============================================================================
Option Explicit

Private Const PPI As Double = 96#          ' pixels per inch (match your PNG export DPI)
Private Const DEFAULT_RIDE As Double = 5#  ' fallback ride duration (minutes)
Private Const OUT_FILE As String = "ridesim_export.txt"
' Full path to index.html. Leave "" to look next to the saved Visio document.
Private Const HTML_PATH_OVERRIDE As String = ""
' Layer holding the background map image; its extent defines where the
' background.png is stretched in node coordinates (nodes sit inside it).
Private Const BG_LAYER As String = "Bck"

Private mPageH As Double                   ' active page height (inches), for Y-flip
Private mNodeMap As Collection             ' "k"&Shape.ID -> Array(id, cxPx, cyPx, role)
Private mAttrMap As Collection             ' "k"&Shape.ID -> attractionId
Private mRole As Collection                ' "k"&Shape.ID -> role (node-like shapes)
Private mScaleIds As Collection            ' "k"&Shape.ID of ScaleStart/ScaleEnd shapes
Private mWarnings As Collection

'------------------------------------------------------------------------------
Public Sub ExportRideSim()
    Dim pg As Visio.Page
    Set pg = Visio.ActivePage
    If pg Is Nothing Then MsgBox "No active page.", vbExclamation: Exit Sub

    mPageH = pg.PageSheet.CellsU("PageHeight").ResultIU
    Set mNodeMap = New Collection
    Set mAttrMap = New Collection
    Set mRole = New Collection
    Set mScaleIds = New Collection
    Set mWarnings = New Collection

    Dim shp As Visio.Shape, v As Variant
    Dim nodesJson As String, attrJson As String, connJson As String
    Dim nodeCount As Long, attrCount As Long, connCount As Long

    ' --- pass A: classify shapes; assign attraction ids ---------------------
    Dim nodeShapes As Collection, entShapes As Collection
    Dim exitShapes As Collection, attractions As Collection
    Set nodeShapes = New Collection
    Set entShapes = New Collection
    Set exitShapes = New Collection
    Set attractions = New Collection
    Dim usedAttr As Collection: Set usedAttr = New Collection

    For Each shp In pg.Shapes
        Dim role As String: role = MasterRole(shp)
        If role <> "" Then mRole.Add role, "k" & shp.id
        If ScaleRole(shp) <> "" Then mScaleIds.Add True, "k" & shp.id
        Select Case role
            Case "Node":     nodeShapes.Add shp
            Case "Entrance": entShapes.Add shp
            Case "Exit":     exitShapes.Add shp
            Case "Attraction", "Restaurant", "Shop", "Pin"  ' all are attractions; category comes from the master
                mAttrMap.Add AttrIdFor(shp, usedAttr), "k" & shp.id
                attractions.Add shp
        End Select
    Next

    ' --- pass B: scan lines. A line touching an Attraction is an association
    '   (which Entrance/Exit belongs to it) and is NOT a walkway edge. Lines
    '   between graph nodes (Node/Entrance/Exit) are walkway edges. ---------
    Dim edgeLines As Collection: Set edgeLines = New Collection
    Dim entOf As Collection, exitOf As Collection
    Set entOf = New Collection   ' "k"&EntranceShapeID -> attrId
    Set exitOf = New Collection  ' "k"&ExitShapeID     -> attrId
    Dim directOf As Collection: Set directOf = New Collection ' "k"&AttractionShapeID -> node ShapeID (non-ride single-node link)
    For Each shp In pg.Shapes
        If MasterRole(shp) = "" And shp.OneD Then
            Dim bShp As Visio.Shape, eShp As Visio.Shape
            Set bShp = Nothing: Set eShp = Nothing
            GetEnds shp, bShp, eShp
            If IsScaleLine(bShp, eShp) Then
                ' the scale bar's line - measured separately, not a walkway edge
            ElseIf bShp Is Nothing Or eShp Is Nothing Then
                Warn "Line not glued at both ends, skipped: " & shp.NameU
            Else
                Dim kb As Visio.Shape, ke As Visio.Shape
                Set kb = ClimbKnown(bShp): Set ke = ClimbKnown(eShp)
                If kb Is Nothing Or ke Is Nothing Then
                    Warn "Line endpoint is not a known shape, skipped: " & shp.NameU
                ElseIf RoleOfShape(kb) = "Attraction" Or RoleOfShape(ke) = "Attraction" Then
                    Dim aShp As Visio.Shape, oShp As Visio.Shape
                    If RoleOfShape(kb) = "Attraction" Then
                        Set aShp = kb: Set oShp = ke
                    Else
                        Set aShp = ke: Set oShp = kb
                    End If
                    Dim aId As String: aId = mAttrMap("k" & aShp.id)
                    Select Case RoleOfShape(oShp)
                        Case "Entrance": PutOnceKey entOf, "k" & oShp.id, aId, "Entrance", shp
                        Case "Exit":     PutOnceKey exitOf, "k" & oShp.id, aId, "Exit", shp
                        Case "Attraction": Warn "Line links two Attractions, ignored: " & shp.NameU
                        Case "Node"
                            ' Rides need an Entrance + Exit; everything else (restaurant/
                            ' shop/pin) hooks straight to a single node used for both.
                            If CategoryOf(aShp) = "ride" Then
                                Warn "Ride '" & aId & "' linked to a plain Node - rides use Entrance/Exit. Ignored."
                            ElseIf KeyExists(directOf, "k" & aShp.id) Then
                                Warn "'" & aId & "' already linked to a node; ignoring extra link from " & shp.NameU & "."
                            Else
                                directOf.Add CStr(oShp.id), "k" & aShp.id
                            End If
                        Case Else: Warn "Attraction '" & aId & "' linked to an unexpected shape. Ignored."
                    End Select
                ElseIf kb.id <> ke.id Then
                    edgeLines.Add shp           ' walkway edge; ids resolved in pass D
                Else
                    Warn "Line skipped (both ends on same shape): " & shp.NameU
                End If
            End If
        End If
    Next

    ' --- pass C: assign node ids -------------------------------------------
    '   Entrance/Exit -> <attractionId>_in / _out. Plain Nodes -> <land><n>,
    '   numbered in spatial order (left->right, then bottom->top).
    Dim usedNode As Collection: Set usedNode = New Collection
    Dim assocEnt As Collection, assocExit As Collection
    Set assocEnt = New Collection   ' attrId -> entrance nodeId
    Set assocExit = New Collection  ' attrId -> exit nodeId

    Dim ordered As Collection: Set ordered = SortNodesSpatially(nodeShapes)
    Dim landCount As Collection: Set landCount = New Collection
    For Each v In ordered
        Set shp = v
        Dim land As String: land = Sanitize(ShapeText(shp))
        Dim nid As String
        If land = "start" Then            ' a node named "Start" -> id "start" (planner's origin)
            nid = UniqueId("start", usedNode)
        Else
            If land = "" Then land = "node"
            nid = UniqueId(land & NextCount(landCount, land), usedNode)
        End If
        Dim cc As Variant: cc = CenterPx(shp)
        mNodeMap.Add Array(nid, cc(0), cc(1), "Node"), "k" & shp.id
        If nodeCount > 0 Then nodesJson = nodesJson & "," & vbCrLf
        nodesJson = nodesJson & NodeJson(nid, False, cc(0), cc(1), PropStr(shp, "Name"))
        nodeCount = nodeCount + 1
    Next

    For Each v In entShapes
        Set shp = v
        Dim eaid As String: eaid = ""
        If KeyExists(entOf, "k" & shp.id) Then eaid = entOf("k" & shp.id)
        Dim eid As String: eid = NodeIdForRole(shp, "Entrance", eaid, "_in", usedNode)
        Dim ec As Variant: ec = CenterPx(shp)
        mNodeMap.Add Array(eid, ec(0), ec(1), "Entrance"), "k" & shp.id
        If nodeCount > 0 Then nodesJson = nodesJson & "," & vbCrLf
        nodesJson = nodesJson & NodeJson(eid, True, ec(0), ec(1), PropStr(shp, "Name"))
        nodeCount = nodeCount + 1
        If eaid <> "" Then PutOnce assocEnt, eaid, eid, "Entrance"
    Next

    For Each v In exitShapes
        Set shp = v
        Dim xaid As String: xaid = ""
        If KeyExists(exitOf, "k" & shp.id) Then xaid = exitOf("k" & shp.id)
        Dim xid As String: xid = NodeIdForRole(shp, "Exit", xaid, "_out", usedNode)
        Dim xc As Variant: xc = CenterPx(shp)
        mNodeMap.Add Array(xid, xc(0), xc(1), "Exit"), "k" & shp.id
        If nodeCount > 0 Then nodesJson = nodesJson & "," & vbCrLf
        nodesJson = nodesJson & NodeJson(xid, True, xc(0), xc(1), PropStr(shp, "Name"))
        nodeCount = nodeCount + 1
        If xaid <> "" Then PutOnce assocExit, xaid, xid, "Exit"
    Next

    ' --- pass D: walkway edges (node ids are now final) --------------------
    For Each v In edgeLines
        Set shp = v
        Dim db As Visio.Shape, de As Visio.Shape
        Set db = Nothing: Set de = Nothing
        GetEnds shp, db, de
        Dim fromId As String, toId As String
        fromId = FinalId(db): toId = FinalId(de)
        If fromId <> "" And toId <> "" And fromId <> toId Then
            Dim ptsJson As String: ptsJson = ConnectorPointsJson(shp, fromId)
            If connCount > 0 Then connJson = connJson & "," & vbCrLf
            connJson = connJson & "  { ""from"": """ & fromId & """, ""to"": """ & toId & _
                       """, ""points"": [" & ptsJson & "] }"
            connCount = connCount + 1
        Else
            Warn "Walkway line could not resolve to two distinct nodes: " & shp.NameU
        End If
    Next

    ' --- pass E: attractions (entrance/exit from association lines) --------
    For Each v In attractions
        Set shp = v
        aId = mAttrMap("k" & shp.id)
        Dim ac As Variant: ac = CenterPx(shp)
        Dim entId As String, exId As String
        entId = "": exId = ""
        If CategoryOf(shp) = "ride" Then
            If KeyExists(assocEnt, aId) Then entId = assocEnt(aId) Else _
                Warn "Ride '" & aId & "' has no Entrance link (draw a line from it to its Entrance node)."
            If KeyExists(assocExit, aId) Then exId = assocExit(aId) Else _
                Warn "Ride '" & aId & "' has no Exit link (draw a line from it to its Exit node)."
        Else
            ' restaurant/shop/pin: a single node link serves as both entrance and exit
            If KeyExists(directOf, "k" & shp.id) Then
                Dim nsid As String: nsid = directOf("k" & shp.id)
                If KeyExists(mNodeMap, "k" & nsid) Then entId = mNodeMap("k" & nsid)(0): exId = entId
            End If
            If entId = "" Then Warn "'" & aId & "' has no node link (draw one line from it to any node)."
        End If
        If attrCount > 0 Then attrJson = attrJson & "," & vbCrLf
        attrJson = attrJson & AttractionJson(aId, ShapeName(shp), entId, exId, ac(0), ac(1), RideDur(shp), CategoryOf(shp), IsClosed(shp), PropStr(shp, "Hovertext"))
        attrCount = attrCount + 1
    Next

    ' --- assemble blocks -----------------------------------------------------
    Dim nodesBlock As String, connBlock As String, attrBlock As String
    Dim mapBlock As String, scaleBlock As String
    nodesBlock = "SAMPLE.nodes = [" & vbCrLf & nodesJson & vbCrLf & "];"
    connBlock = "SAMPLE.connections = [" & vbCrLf & connJson & vbCrLf & "];"
    attrBlock = "SAMPLE.attractions = [" & vbCrLf & attrJson & vbCrLf & "];"
    mapBlock = "SAMPLE.mapExtent = " & MapExtentJson(pg) & ";"

    Dim ftPerPx As Double: ftPerPx = ComputeScale(pg)
    If ftPerPx > 0 Then
        scaleBlock = "SAMPLE.feetPerPixel = " & JNum(ftPerPx) & ";"
    Else
        scaleBlock = "SAMPLE.feetPerPixel = null;"
    End If

    Dim outText As String   ' plain-text fallback (same blocks, copy/paste-able)
    outText = nodesBlock & vbCrLf & vbCrLf & connBlock & vbCrLf & vbCrLf & _
              attrBlock & vbCrLf & vbCrLf & mapBlock & vbCrLf & vbCrLf & scaleBlock & vbCrLf
    Debug.Print outText

    ' --- emit: patch index.html in place, else write the .txt ----------------
    '   (VBA And is not short-circuit, so guard with nested Ifs.)
    Dim msg As String, htmlP As String, didPatch As Boolean
    htmlP = HtmlPath()
    If htmlP <> "" Then
        If Dir$(htmlP) <> "" Then didPatch = PatchHtml(htmlP, nodesBlock, connBlock, attrBlock, mapBlock, scaleBlock)
    End If
    If didPatch Then
        msg = "Wrote " & nodeCount & " nodes, " & connCount & " connections, " & _
              attrCount & " attractions into:" & vbCrLf & htmlP & vbCrLf & _
              "Refresh the page in your browser."
    Else
        Dim savedTo As String: savedTo = WriteOut(outText)
        msg = "Exported " & nodeCount & " nodes, " & connCount & " connections, " & _
              attrCount & " attractions." & vbCrLf & _
              "Could not patch index.html (not found or markers missing), wrote:" & vbCrLf & _
              savedTo & vbCrLf & "Paste the blocks in manually."
    End If

    If mWarnings.Count > 0 Then
        Dim wv As Variant, wAll As String
        For Each wv In mWarnings: wAll = wAll & vbCrLf & " - " & wv: Next
        Debug.Print "WARNINGS:" & wAll
        msg = msg & vbCrLf & vbCrLf & mWarnings.Count & " warning(s) - see Immediate window (Ctrl+G)."
    End If
    MsgBox msg, vbInformation, "RideSim Export"
End Sub

'--------------------------- index.html patching ------------------------------
' Path to index.html: HTML_PATH_OVERRIDE if set, else next to the Visio doc.
Private Function HtmlPath() As String
    If HTML_PATH_OVERRIDE <> "" Then HtmlPath = HTML_PATH_OVERRIDE: Exit Function
    Dim folder As String
    On Error Resume Next
    folder = ThisDocument.path
    On Error GoTo 0
    If folder = "" Then Exit Function
    If Right$(folder, 1) <> "\" Then folder = folder & "\"
    HtmlPath = folder & "index.html"
End Function

' Replace the text between each marker pair with its block. Returns False (and
' leaves the file untouched) if any marker is missing.
Private Function PatchHtml(path As String, nodesBlock As String, connBlock As String, _
                           attrBlock As String, mapBlock As String, scaleBlock As String) As Boolean
    On Error GoTo fail
    Dim s As String: s = ReadTextUtf8(path)
    Dim nl As String: nl = IIf(InStr(s, vbCrLf) > 0, vbCrLf, vbLf)
    Dim ok As Boolean: ok = True
    s = PatchSection(s, "@RIDESIM:NODES:START", "@RIDESIM:NODES:END", Reflow(nodesBlock, nl), nl, ok)
    s = PatchSection(s, "@RIDESIM:CONN:START", "@RIDESIM:CONN:END", Reflow(connBlock, nl), nl, ok)
    s = PatchSection(s, "@RIDESIM:ATTR:START", "@RIDESIM:ATTR:END", Reflow(attrBlock, nl), nl, ok)
    s = PatchSection(s, "@RIDESIM:MAP:START", "@RIDESIM:MAP:END", Reflow(mapBlock, nl), nl, ok)
    s = PatchSection(s, "@RIDESIM:SCALE:START", "@RIDESIM:SCALE:END", Reflow(scaleBlock, nl), nl, ok)
    If ok Then WriteTextUtf8NoBom path, s   ' only touch the file if every marker matched
    PatchHtml = ok
    Exit Function
fail:
    Warn "Could not patch index.html: " & Err.Description
    PatchHtml = False
End Function

' Keep the two marker lines; replace only the lines strictly between them.
Private Function PatchSection(s As String, startTok As String, endTok As String, _
                              block As String, nl As String, ByRef ok As Boolean) As String
    Dim p1 As Long, p2 As Long
    p1 = InStr(s, startTok): p2 = InStr(s, endTok)
    If p1 = 0 Or p2 = 0 Or p2 < p1 Then
        Warn "Marker not found in index.html: " & startTok & " .. " & endTok
        ok = False: PatchSection = s: Exit Function
    End If
    Dim eol As Long: eol = InStr(p1, s, vbLf)        ' end of the start-marker line
    If eol = 0 Then ok = False: PatchSection = s: Exit Function
    Dim lineStart As Long: lineStart = InStrRev(s, vbLf, p2) + 1  ' start of end-marker line
    PatchSection = Left$(s, eol) & block & nl & Mid$(s, lineStart)
End Function

Private Function Reflow(block As String, nl As String) As String
    Reflow = Replace(block, vbCrLf, nl)
End Function

' UTF-8 read/write (preserves emoji, em-dashes, etc.); write without BOM.
Private Function ReadTextUtf8(path As String) As String
    Dim st As Object: Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    st.LoadFromFile path
    ReadTextUtf8 = st.ReadText
    st.Close
End Function

Private Sub WriteTextUtf8NoBom(path As String, ByVal text As String)
    Dim st As Object: Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    st.WriteText text
    st.Position = 0: st.Type = 1: st.Position = 3   ' skip the 3-byte UTF-8 BOM
    Dim payload: payload = st.Read
    st.Close
    Dim bin As Object: Set bin = CreateObject("ADODB.Stream")
    bin.Type = 1: bin.Open
    bin.Write payload
    bin.SaveToFile path, 2                           ' adSaveCreateOverWrite
    bin.Close
End Sub

'============================ helpers =========================================

Private Function MasterRole(shp As Visio.Shape) As String
    On Error Resume Next
    If shp.Master Is Nothing Then Exit Function
    Dim nm As String: nm = LCase$(shp.Master.Name)
    Dim nu As String: nu = LCase$(shp.Master.NameU)
    Select Case True
        Case nm = "attraction", nu = "attraction": MasterRole = "Attraction"
        Case nm = "restaurant", nu = "restaurant": MasterRole = "Restaurant"
        Case nm = "shop", nu = "shop", nm = "shops", nu = "shops": MasterRole = "Shop"
        Case nm = "pin", nu = "pin", nm = "pins", nu = "pins": MasterRole = "Pin"
        Case nm = "entrance", nu = "entrance":     MasterRole = "Entrance"
        Case nm = "exit", nu = "exit":             MasterRole = "Exit"
        Case nm = "node", nu = "node":             MasterRole = "Node"
    End Select
End Function

' Shape center in pixels (page coords -> screen-space px, Y flipped)
Private Function CenterPx(shp As Visio.Shape) As Variant
    Dim x As Double, y As Double
    x = shp.CellsU("PinX").ResultIU
    y = shp.CellsU("PinY").ResultIU
    CenterPx = Array(Round(x * PPI), Round((mPageH - y) * PPI))
End Function

' Convert a LOCAL geometry coordinate (inches) to page pixels (Y flipped)
Private Function LocalToPagePx(shp As Visio.Shape, xl As Double, yl As Double) As Variant
    Dim w As Double, h As Double, lpx As Double, lpy As Double
    Dim pinx As Double, piny As Double, ang As Double, fx As Boolean, fy As Boolean
    w = CN(shp, "Width"): h = CN(shp, "Height")
    lpx = CN(shp, "LocPinX"): lpy = CN(shp, "LocPinY")
    pinx = CN(shp, "PinX"): piny = CN(shp, "PinY")
    ang = CN(shp, "Angle"): fx = (CN(shp, "FlipX") <> 0): fy = (CN(shp, "FlipY") <> 0)
    If fx Then xl = w - xl
    If fy Then yl = h - yl
    Dim dx As Double, dy As Double, xr As Double, yr As Double
    dx = xl - lpx: dy = yl - lpy
    xr = dx * Cos(ang) - dy * Sin(ang)
    yr = dx * Sin(ang) + dy * Cos(ang)
    Dim xp As Double, yp As Double
    xp = pinx + xr: yp = piny + yr
    LocalToPagePx = Array(Round(xp * PPI), Round((mPageH - yp) * PPI))
End Function

' Bounding box (in node px) of the shape(s) on the BG_LAYER layer = where the
' background.png is stretched. Returns "{ x, y, w, h }" or "null" if none.
Private Function MapExtentJson(pg As Visio.Page) As String
    Dim shp As Visio.Shape, found As Boolean
    Dim minX As Double, minY As Double, maxX As Double, maxY As Double
    minX = 1E+30: minY = 1E+30: maxX = -1E+30: maxY = -1E+30
    For Each shp In pg.Shapes
        ' only the image itself - never nodes/attractions/scale shapes on the layer
        If OnLayer(shp, BG_LAYER) And MasterRole(shp) = "" And ScaleRole(shp) = "" Then
            found = True
            Dim w As Double, h As Double, i As Long, pt As Variant
            w = CN(shp, "Width"): h = CN(shp, "Height")
            Dim corners(0 To 3) As Variant
            corners(0) = LocalToPagePx(shp, 0, 0)
            corners(1) = LocalToPagePx(shp, w, 0)
            corners(2) = LocalToPagePx(shp, w, h)
            corners(3) = LocalToPagePx(shp, 0, h)
            For i = 0 To 3
                pt = corners(i)
                If pt(0) < minX Then minX = pt(0)
                If pt(0) > maxX Then maxX = pt(0)
                If pt(1) < minY Then minY = pt(1)
                If pt(1) > maxY Then maxY = pt(1)
            Next i
        End If
    Next shp
    If Not found Then
        Warn "No shape on layer '" & BG_LAYER & "' - map extent not exported (background won't auto-align)."
        MapExtentJson = "null"
    Else
        MapExtentJson = "{ ""x"": " & CLng(minX) & ", ""y"": " & CLng(minY) & _
            ", ""w"": " & CLng(maxX - minX) & ", ""h"": " & CLng(maxY - minY) & " }"
    End If
End Function

' True if a shape belongs to a layer with the given name.
Private Function OnLayer(shp As Visio.Shape, layerName As String) As Boolean
    On Error Resume Next
    Dim i As Long
    For i = 1 To shp.LayerCount
        If LCase$(shp.Layer(i).Name) = LCase$(layerName) Then OnLayer = True: Exit Function
    Next i
End Function

' "ScaleStart" / "ScaleEnd" / "" - by master name or shape name.
Private Function ScaleRole(shp As Visio.Shape) As String
    On Error Resume Next
    Dim nm As String
    If Not shp.Master Is Nothing Then nm = LCase$(shp.Master.Name)
    Dim nu As String: nu = LCase$(shp.NameU)
    If nm = "scalestart" Or InStr(nu, "scalestart") > 0 Then ScaleRole = "ScaleStart": Exit Function
    If nm = "scaleend" Or InStr(nu, "scaleend") > 0 Then ScaleRole = "ScaleEnd"
End Function

' True if a line's two endpoints are the scale-bar shapes (either direction).
Private Function IsScaleLine(b As Visio.Shape, e As Visio.Shape) As Boolean
    If b Is Nothing Or e Is Nothing Then Exit Function
    IsScaleLine = KeyExists(mScaleIds, "k" & b.id) And KeyExists(mScaleIds, "k" & e.id)
End Function

' Feet-per-pixel from the scale bar: feet (text on the connecting line, else on
' a scale shape) divided by the pixel distance between ScaleStart and ScaleEnd.
Private Function ComputeScale(pg As Visio.Page) As Double
    Dim shp As Visio.Shape, sShp As Visio.Shape, eShp As Visio.Shape
    For Each shp In pg.Shapes
        Select Case ScaleRole(shp)
            Case "ScaleStart": Set sShp = shp
            Case "ScaleEnd": Set eShp = shp
        End Select
    Next
    If sShp Is Nothing Or eShp Is Nothing Then Exit Function   ' no scale bar -> 0

    Dim feet As Double, ln As Visio.Shape
    For Each shp In pg.Shapes                                   ' find the connecting line
        If shp.OneD And MasterRole(shp) = "" Then
            Dim b As Visio.Shape, e As Visio.Shape
            Set b = Nothing: Set e = Nothing
            GetEnds shp, b, e
            If Not b Is Nothing And Not e Is Nothing Then
                If (b.id = sShp.id And e.id = eShp.id) Or (b.id = eShp.id And e.id = sShp.id) Then
                    Set ln = shp: Exit For
                End If
            End If
        End If
    Next
    If Not ln Is Nothing Then feet = ParseNum(ShapeText(ln))
    If feet <= 0 Then feet = ParseNum(ShapeText(sShp))
    If feet <= 0 Then feet = ParseNum(ShapeText(eShp))
    If feet <= 0 Then
        Warn "Found ScaleStart/ScaleEnd but no distance text (feet) - scale not set."
        Exit Function
    End If

    Dim cs As Variant, ce As Variant
    cs = CenterPx(sShp): ce = CenterPx(eShp)
    Dim d As Double: d = Sqr((cs(0) - ce(0)) ^ 2 + (cs(1) - ce(1)) ^ 2)
    If d <= 0 Then Exit Function
    ComputeScale = feet / d
End Function

' First number in a string ("350 ft" -> 350, "12.5" -> 12.5). 0 if none.
Private Function ParseNum(ByVal s As String) As Double
    Dim i As Long, ch As String, num As String, seenDot As Boolean
    For i = 1 To Len(s)
        ch = Mid$(s, i, 1)
        If ch >= "0" And ch <= "9" Then
            num = num & ch
        ElseIf ch = "." And Not seenDot And num <> "" Then
            num = num & ".": seenDot = True
        ElseIf num <> "" Then
            Exit For
        End If
    Next i
    If num <> "" Then ParseNum = val(num)   ' Val uses "." regardless of locale
End Function

' Number -> locale-safe JSON literal (always "." decimal, no scientific).
Private Function JNum(d As Double) As String
    JNum = Replace(Format$(d, "0.######"), ",", ".")
End Function

' Build the JSON points list for a connector, ordered begin(fromId) -> end.
Private Function ConnectorPointsJson(shp As Visio.Shape, fromId As String) As String
    Dim pts As Collection: Set pts = New Collection
    On Error Resume Next

    ' walk every geometry section's vertices (approximates arcs by endpoints)
    Dim i As Long, r As Long
    For i = 1 To shp.GeometryCount
        r = 1
        Do While shp.CellExistsU("Geometry" & i & ".X" & r, 0)
            Dim xl As Double, yl As Double
            xl = shp.CellsU("Geometry" & i & ".X" & r).ResultIU
            yl = shp.CellsU("Geometry" & i & ".Y" & r).ResultIU
            pts.Add LocalToPagePx(shp, xl, yl)
            r = r + 1
        Loop
    Next i

    ' fallback: straight begin/end in page coords
    If pts.Count < 2 Then
        Set pts = New Collection
        pts.Add Array(Round(CN(shp, "BeginX") * PPI), Round((mPageH - CN(shp, "BeginY")) * PPI))
        pts.Add Array(Round(CN(shp, "EndX") * PPI), Round((mPageH - CN(shp, "EndY")) * PPI))
    End If
    On Error GoTo 0

    ' orient so the first point is nearest the "from" node
    Dim fromC As Variant: fromC = NodeCenter(fromId)
    If Not IsEmpty(fromC) And pts.Count >= 2 Then
        Dim p1 As Variant, pN As Variant
        p1 = pts(1): pN = pts(pts.Count)
        If Dist2(pN, fromC) < Dist2(p1, fromC) Then Set pts = ReverseCol(pts)
    End If

    Dim s As String, k As Long, pv As Variant
    For k = 1 To pts.Count
        pv = pts(k)
        If k > 1 Then s = s & ", "
        s = s & "{ ""x"": " & CLng(pv(0)) & ", ""y"": " & CLng(pv(1)) & " }"
    Next k
    ConnectorPointsJson = s
End Function

' Determine the begin/end node shapes a connector is glued to.
Private Sub GetEnds(CN As Visio.Shape, ByRef bShp As Visio.Shape, ByRef eShp As Visio.Shape)
    On Error Resume Next
    Dim cx As Visio.Connect
    For Each cx In CN.Connects
        Dim nm As String: nm = cx.FromCell.Name
        If InStr(1, nm, "Begin", vbTextCompare) > 0 Then
            Set bShp = cx.ToSheet
        ElseIf InStr(1, nm, "End", vbTextCompare) > 0 Then
            Set eShp = cx.ToSheet
        End If
    Next cx
End Sub

' Climb from a (possibly sub-) shape to the nearest enclosing shape that is one
' of our known shapes (a graph node or an attraction). Nothing if none.
Private Function ClimbKnown(shp As Visio.Shape) As Visio.Shape
    On Error Resume Next
    Dim s As Visio.Shape: Set s = shp
    Do While Not s Is Nothing
        If KeyExists(mRole, "k" & s.id) Or KeyExists(mAttrMap, "k" & s.id) Then
            Set ClimbKnown = s: Exit Function
        End If
        If s.ContainingShape Is Nothing Then Exit Do
        If s.ContainingShape.id = s.id Then Exit Do
        Set s = s.ContainingShape
    Loop
End Function

Private Function RoleOfShape(s As Visio.Shape) As String
    If KeyExists(mAttrMap, "k" & s.id) Then RoleOfShape = "Attraction": Exit Function
    If KeyExists(mRole, "k" & s.id) Then RoleOfShape = mRole("k" & s.id)
End Function

' Web category from the shape's master role. Attractions are all stored
' together, so the original master role is kept in mRole and read back here.
Private Function CategoryOf(shp As Visio.Shape) As String
    CategoryOf = "ride"
    If KeyExists(mRole, "k" & shp.id) Then
        Select Case mRole("k" & shp.id)
            Case "Restaurant": CategoryOf = "restaurant"
            Case "Shop":       CategoryOf = "shop"
            Case "Pin":        CategoryOf = "pin"
        End Select
    End If
End Function

' Final node id for a (possibly sub-) shape, after pass C assigned ids.
Private Function FinalId(shp As Visio.Shape) As String
    Dim s As Visio.Shape: Set s = ClimbKnown(shp)
    If s Is Nothing Then Exit Function
    If KeyExists(mNodeMap, "k" & s.id) Then FinalId = mNodeMap("k" & s.id)(0)
End Function

' Record an attraction->entrance/exit nodeId association; warn on a second.
Private Sub PutOnce(c As Collection, key As String, val As String, label As String)
    If KeyExists(c, key) Then
        Warn "Attraction '" & key & "' has multiple " & label & " links; keeping '" & _
             c(key) & "', ignoring '" & val & "'."
    Else
        c.Add val, key
    End If
End Sub

' Record which attraction an Entrance/Exit shape belongs to; warn on a second.
Private Sub PutOnceKey(c As Collection, key As String, val As String, label As String, lineShp As Visio.Shape)
    If KeyExists(c, key) Then
        Warn label & " node already linked to attraction '" & c(key) & _
             "'; ignoring extra link from line " & lineShp.NameU & "."
    Else
        c.Add val, key
    End If
End Sub

'--------------------------- id / value readers -------------------------------
' Attraction id: Prop.ID, else sanitized shape text, else "a"&ShapeID. Unique.
Private Function AttrIdFor(shp As Visio.Shape, used As Collection) As String
    Dim p As String: p = PropStr(shp, "ID")
    If p <> "" Then AttrIdFor = UniqueId(p, used): Exit Function
    Dim t As String: t = Sanitize(ShapeText(shp))
    If t <> "" Then AttrIdFor = UniqueId(t, used): Exit Function
    AttrIdFor = UniqueId("a" & shp.id, used)
End Function

' Entrance/Exit id: Prop.ID, else <attractionId><suffix> (e.g. pirates_in).
Private Function NodeIdForRole(shp As Visio.Shape, role As String, attrId As String, _
                               suffix As String, used As Collection) As String
    Dim p As String: p = PropStr(shp, "ID")
    If p <> "" Then NodeIdForRole = UniqueId(p, used): Exit Function
    If attrId <> "" Then NodeIdForRole = UniqueId(attrId & suffix, used): Exit Function
    Warn role & " node (Shape ID " & shp.id & ") is not linked to an Attraction - " & _
         "draw a line from its Attraction shape to it."
    NodeIdForRole = UniqueId(IIf(role = "Entrance", "ent", "ex") & shp.id, used)
End Function

' Lowercase, keep a-z0-9, turn spaces/-/_ into single underscores, trim them.
Private Function Sanitize(ByVal s As String) As String
    Dim i As Long, ch As String, out As String
    s = LCase$(Trim$(s))
    For i = 1 To Len(s)
        ch = Mid$(s, i, 1)
        If (ch >= "a" And ch <= "z") Or (ch >= "0" And ch <= "9") Then
            out = out & ch
        ElseIf ch = " " Or ch = "-" Or ch = "_" Then
            out = out & "_"
        End If
    Next i
    Do While InStr(out, "__") > 0: out = Replace(out, "__", "_"): Loop
    Do While Len(out) > 0 And Left$(out, 1) = "_": out = Mid$(out, 2): Loop
    Do While Len(out) > 0 And Right$(out, 1) = "_": out = Left$(out, Len(out) - 1): Loop
    Sanitize = out
End Function

' Return base, or base_2, base_3... so it is unique; records it in `used`.
Private Function UniqueId(ByVal base As String, used As Collection) As String
    If base = "" Then base = "x"
    Dim id As String: id = base
    Dim n As Long: n = 2
    Do While KeyExists(used, id)
        id = base & "_" & n: n = n + 1
    Loop
    used.Add id, id
    UniqueId = id
End Function

' Per-key running counter (1,2,3...) stored in a Collection.
Private Function NextCount(c As Collection, key As String) As Long
    Dim n As Long
    If KeyExists(c, key) Then n = c(key): c.Remove key
    n = n + 1
    c.Add n, key
    NextCount = n
End Function

Private Function ShapeText(shp As Visio.Shape) As String
    On Error Resume Next
    ShapeText = Trim$(shp.text)
End Function

' Order node shapes left->right, then bottom->top (for stable auto numbering).
Private Function SortNodesSpatially(coll As Collection) As Collection
    Dim res As New Collection
    Dim nN As Long: nN = coll.Count
    If nN = 0 Then Set SortNodesSpatially = res: Exit Function
    Dim sh() As Visio.Shape, xs() As Double, ys() As Double, idx() As Long
    ReDim sh(1 To nN): ReDim xs(1 To nN): ReDim ys(1 To nN): ReDim idx(1 To nN)
    Dim i As Long
    For i = 1 To nN
        Set sh(i) = coll(i)
        Dim cc As Variant: cc = CenterPx(sh(i))
        xs(i) = cc(0): ys(i) = cc(1): idx(i) = i
    Next i
    Dim j As Long, k As Long, t As Long
    For j = 2 To nN                     ' insertion sort on idx
        k = j
        Do While k > 1
            If LessNode(xs(idx(k)), ys(idx(k)), xs(idx(k - 1)), ys(idx(k - 1))) Then
                t = idx(k): idx(k) = idx(k - 1): idx(k - 1) = t
                k = k - 1
            Else
                Exit Do
            End If
        Loop
    Next j
    For i = 1 To nN: res.Add sh(idx(i)): Next i
    Set SortNodesSpatially = res
End Function

' True if (ax,ay) sorts before (bx,by): left->right, ties (same column within
' EPS px) bottom->top (larger y first, since y grows downward on screen).
Private Function LessNode(ax As Double, ay As Double, bx As Double, by As Double) As Boolean
    Const EPS As Double = 8
    If Abs(ax - bx) > EPS Then LessNode = (ax < bx) Else LessNode = (ay > by)
End Function

' Ride duration (minutes) from the attraction's Shape Data. Tries common field
' names; numeric or text ("12 min") both work. Falls back to DEFAULT_RIDE.
Private Function RideDur(shp As Visio.Shape) As Double
    On Error Resume Next
    Dim names As Variant: names = Array("RideDuration", "Duration", "RideTime", "Ride", "Minutes")
    Dim i As Long, cell As String, v As Double
    Dim Row As Long
    For Row = 0 To shp.RowCount(visSectionProp) - 1
        For i = LBound(names) To UBound(names)
            cell = "Prop." & names(i)
            If shp.CellsSRC(visSectionProp, Row, 2).ResultStr(visNone) Like names(i) Then
                v = shp.CellsSRC(visSectionProp, Row, 0).Result(visNone)                 ' numeric shape data
                If v <= 0 Then v = ParseNum(shp.CellsU(cell).ResultStr(""))  ' text shape data
                If v > 0 Then RideDur = v: Exit Function
            End If
        Next i
    Next Row
    RideDur = DEFAULT_RIDE
End Function

Private Function ShapeName(shp As Visio.Shape) As String
    Dim p As String: p = PropStr(shp, "Name")
    If p <> "" Then ShapeName = p: Exit Function
    On Error Resume Next
    ShapeName = Trim$(shp.text)
End Function

Private Function PropStr(shp As Visio.Shape, propName As String) As String
    On Error Resume Next
    If shp.CellExistsU("Prop." & propName, 0) Then
        PropStr = shp.CellsU("Prop." & propName).ResultStr("")
    End If
End Function

Private Function CN(shp As Visio.Shape, cell As String) As Double
    On Error Resume Next
    CN = shp.CellsU(cell).ResultIU
End Function

'--------------------------- json builders ------------------------------------
Private Function NodeJson(id As String, isAttr As Boolean, x As Variant, y As Variant, nm As String) As String
    Dim s As String
    s = "  { ""id"": """ & id & """"
    If nm <> "" Then s = s & ", ""name"": """ & JStr(nm) & """"
    s = s & ", ""isAttraction"": " & LCase$(CStr(isAttr)) & _
        ", ""x"": " & CLng(x) & ", ""y"": " & CLng(y) & " }"
    NodeJson = s
End Function

Private Function AttractionJson(id As String, nm As String, entId As String, exId As String, _
                          x As Variant, y As Variant, ride As Double, cat As String, _
                          closed As Boolean, hover As String) As String
    ' Emit category/closed/hoverText only when set; otherwise lines match the
    ' original shape so the web app (ride/open/no-hover defaults) is happy.
    Dim catJson As String
    If cat <> "ride" Then catJson = ", ""category"": """ & cat & """"
    Dim closedJson As String
    If closed Then closedJson = ", ""closed"": true"
    Dim hoverJson As String
    If Trim$(hover) <> "" Then hoverJson = ", ""hoverText"": """ & JStr(hover) & """"
    AttractionJson = "  { ""id"": """ & id & """, ""name"": """ & JStr(nm) & _
        """, ""entranceNodeId"": """ & entId & """, ""exitNodeId"": """ & exId & _
        """, ""displayLocation"": { ""x"": " & CLng(x) & ", ""y"": " & CLng(y) & _
        " }, ""rideDuration"": " & CLng(Round(ride)) & catJson & closedJson & hoverJson & " }"
End Function

' True when the shape's "Closed" shape data is set (not open at the park today).
' Accepts Visio Boolean cells (TRUE/FALSE) as well as text/numeric truthy values.
Private Function IsClosed(shp As Visio.Shape) As Boolean
    On Error Resume Next
    If Not shp.CellExistsU("Prop.Closed", 0) Then Exit Function
    Dim v As String: v = UCase$(Trim$(shp.CellsU("Prop.Closed").ResultStr("")))
    If v = "TRUE" Or v = "1" Or v = "YES" Or v = "Y" Then IsClosed = True
    If shp.CellsU("Prop.Closed").Result(visNone) <> 0 Then IsClosed = True
End Function

Private Function JStr(s As String) As String
    s = Replace(s, "\", "\\")
    s = Replace(s, """", "\""")
    s = Replace(s, vbCr, "\r")
    s = Replace(s, vbLf, "\n")
    s = Replace(s, vbTab, "\t")
    JStr = s
End Function

'--------------------------- small utilities ----------------------------------
Private Function NodeCenter(id As String) As Variant
    Dim v As Variant
    For Each v In mNodeMap
        If v(0) = id Then NodeCenter = Array(v(1), v(2)): Exit Function
    Next v
End Function

Private Function Dist2(a As Variant, b As Variant) As Double
    Dist2 = (a(0) - b(0)) ^ 2 + (a(1) - b(1)) ^ 2
End Function

Private Function ReverseCol(c As Collection) As Collection
    Dim r As New Collection, i As Long
    For i = c.Count To 1 Step -1: r.Add c(i): Next i
    Set ReverseCol = r
End Function

Private Function KeyExists(c As Collection, k As String) As Boolean
    On Error GoTo nope
    Dim tmp As Variant: tmp = c(k)
    KeyExists = True
    Exit Function
nope:
    KeyExists = False
End Function

Private Sub Warn(msg As String)
    mWarnings.Add msg
End Sub

Private Function WriteOut(text As String) As String
    Dim folder As String
    On Error Resume Next
    folder = ThisDocument.path
    On Error GoTo 0
    If folder = "" Then folder = Environ$("USERPROFILE") & "\Desktop\"
    If Right$(folder, 1) <> "\" Then folder = folder & "\"
    Dim path As String: path = folder & OUT_FILE
    Dim f As Integer: f = FreeFile
    Open path For Output As #f
    Print #f, text
    Close #f
    WriteOut = path
End Function




