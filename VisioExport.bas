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
'   5. Output is written to "ridesim_export.txt" next to the .vsdx (or your
'      Desktop if unsaved) AND printed to the Immediate window (Ctrl+G).
'      Copy each block into index.html's Data panel (or the SAMPLE arrays).
'
' AUTO-NAMING (no shape data needed - just set shape TEXT):
'   Attraction : id = sanitized attraction TEXT (e.g. "Pirates" -> pirates).
'   Entrance   : id = <attractionId>_in   (taken from its association line).
'   Exit       : id = <attractionId>_out.
'   Node       : set its TEXT to the LAND it sits in (e.g. "Adventureland").
'                id = <land><n>, numbered left->right then bottom->top
'                (e.g. adventureland1, adventureland2 ...). Blank text -> node1..
'   Ids are forced unique; a clash gets _2, _3 appended.
'
' OPTIONAL SHAPE DATA (Shape Data / Custom Properties) - all override the above:
'   On any shape:        Prop.ID          -> use this exact id instead of auto
'                        Prop.Name        -> JSON "name" (else omitted for nodes)
'   On Attraction:       Prop.RideDuration-> ride minutes (else DEFAULT_RIDE)
'
' COORDINATES
'   Visio is inches, origin bottom-left, Y up. We emit pixels, origin top-left,
'   Y down (screen space), so node coords line up with a page exported to PNG.
'   Set PPI below to the DPI you export background.png at (Visio default = 96).
'==============================================================================
Option Explicit

Private Const PPI As Double = 96#          ' pixels per inch (match your PNG export DPI)
Private Const DEFAULT_RIDE As Double = 5#  ' fallback ride duration (minutes)
Private Const OUT_FILE As String = "ridesim_export.txt"

Private mPageH As Double                   ' active page height (inches), for Y-flip
Private mNodeMap As Collection             ' "k"&Shape.ID -> Array(id, cxPx, cyPx, role)
Private mAttrMap As Collection             ' "k"&Shape.ID -> attractionId
Private mRole As Collection                ' "k"&Shape.ID -> role (node-like shapes)
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
        If role <> "" Then mRole.Add role, "k" & shp.ID
        Select Case role
            Case "Node":     nodeShapes.Add shp
            Case "Entrance": entShapes.Add shp
            Case "Exit":     exitShapes.Add shp
            Case "Attraction"
                mAttrMap.Add AttrIdFor(shp, usedAttr), "k" & shp.ID
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
    For Each shp In pg.Shapes
        If MasterRole(shp) = "" And shp.OneD Then
            Dim bShp As Visio.Shape, eShp As Visio.Shape
            Set bShp = Nothing: Set eShp = Nothing
            GetEnds shp, bShp, eShp
            If bShp Is Nothing Or eShp Is Nothing Then
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
                    Dim aid As String: aid = mAttrMap("k" & aShp.ID)
                    Select Case RoleOfShape(oShp)
                        Case "Entrance": PutOnceKey entOf, "k" & oShp.ID, aid, "Entrance", shp
                        Case "Exit":     PutOnceKey exitOf, "k" & oShp.ID, aid, "Exit", shp
                        Case "Attraction": Warn "Line links two Attractions, ignored: " & shp.NameU
                        Case Else: Warn "Attraction '" & aid & "' linked to a plain Node - link Attractions only to Entrance/Exit. Ignored."
                    End Select
                ElseIf kb.ID <> ke.ID Then
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
        If land = "" Then land = "node"
        Dim nid As String: nid = UniqueId(land & NextCount(landCount, land), usedNode)
        Dim cc As Variant: cc = CenterPx(shp)
        mNodeMap.Add Array(nid, cc(0), cc(1), "Node"), "k" & shp.ID
        If nodeCount > 0 Then nodesJson = nodesJson & "," & vbCrLf
        nodesJson = nodesJson & NodeJson(nid, False, cc(0), cc(1), PropStr(shp, "Name"))
        nodeCount = nodeCount + 1
    Next

    For Each v In entShapes
        Set shp = v
        Dim eaid As String: eaid = ""
        If KeyExists(entOf, "k" & shp.ID) Then eaid = entOf("k" & shp.ID)
        Dim eid As String: eid = NodeIdForRole(shp, "Entrance", eaid, "_in", usedNode)
        Dim ec As Variant: ec = CenterPx(shp)
        mNodeMap.Add Array(eid, ec(0), ec(1), "Entrance"), "k" & shp.ID
        If nodeCount > 0 Then nodesJson = nodesJson & "," & vbCrLf
        nodesJson = nodesJson & NodeJson(eid, True, ec(0), ec(1), PropStr(shp, "Name"))
        nodeCount = nodeCount + 1
        If eaid <> "" Then PutOnce assocEnt, eaid, eid, "Entrance"
    Next

    For Each v In exitShapes
        Set shp = v
        Dim xaid As String: xaid = ""
        If KeyExists(exitOf, "k" & shp.ID) Then xaid = exitOf("k" & shp.ID)
        Dim xid As String: xid = NodeIdForRole(shp, "Exit", xaid, "_out", usedNode)
        Dim xc As Variant: xc = CenterPx(shp)
        mNodeMap.Add Array(xid, xc(0), xc(1), "Exit"), "k" & shp.ID
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
        Dim aId As String: aId = mAttrMap("k" & shp.ID)
        Dim ac As Variant: ac = CenterPx(shp)
        Dim entId As String, exId As String
        If KeyExists(assocEnt, aId) Then entId = assocEnt(aId) Else _
            Warn "Attraction '" & aId & "' has no Entrance link (draw a line from it to its Entrance node)."
        If KeyExists(assocExit, aId) Then exId = assocExit(aId) Else _
            Warn "Attraction '" & aId & "' has no Exit link (draw a line from it to its Exit node)."
        If attrCount > 0 Then attrJson = attrJson & "," & vbCrLf
        attrJson = attrJson & AttrJson(aId, ShapeName(shp), entId, exId, ac(0), ac(1), RideDur(shp))
        attrCount = attrCount + 1
    Next

    ' --- assemble + emit -----------------------------------------------------
    Dim outText As String
    outText = "// ===== NODES =====" & vbCrLf & "[" & vbCrLf & nodesJson & vbCrLf & "]" & vbCrLf & vbCrLf & _
              "// ===== CONNECTIONS =====" & vbCrLf & "[" & vbCrLf & connJson & vbCrLf & "]" & vbCrLf & vbCrLf & _
              "// ===== ATTRACTIONS =====" & vbCrLf & "[" & vbCrLf & attrJson & vbCrLf & "]" & vbCrLf

    Debug.Print outText
    Dim savedTo As String: savedTo = WriteOut(outText)

    Dim msg As String
    msg = "Exported " & nodeCount & " nodes, " & connCount & " connections, " & _
          attrCount & " attractions." & vbCrLf & "Saved to: " & savedTo
    If mWarnings.Count > 0 Then
        Dim wv As Variant, wAll As String
        For Each wv In mWarnings: wAll = wAll & vbCrLf & " - " & wv: Next
        Debug.Print "WARNINGS:" & wAll
        msg = msg & vbCrLf & vbCrLf & mWarnings.Count & " warning(s) - see Immediate window."
    End If
    MsgBox msg, vbInformation, "RideSim Export"
End Sub

'============================ helpers =========================================

Private Function MasterRole(shp As Visio.Shape) As String
    On Error Resume Next
    If shp.Master Is Nothing Then Exit Function
    Dim nm As String: nm = LCase$(shp.Master.Name)
    Dim nu As String: nu = LCase$(shp.Master.NameU)
    Select Case True
        Case nm = "attraction", nu = "attraction": MasterRole = "Attraction"
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
Private Sub GetEnds(cn As Visio.Shape, ByRef bShp As Visio.Shape, ByRef eShp As Visio.Shape)
    On Error Resume Next
    Dim cx As Visio.Connect
    For Each cx In cn.Connects
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
        If KeyExists(mRole, "k" & s.ID) Or KeyExists(mAttrMap, "k" & s.ID) Then
            Set ClimbKnown = s: Exit Function
        End If
        If s.ContainingShape Is Nothing Then Exit Do
        If s.ContainingShape.ID = s.ID Then Exit Do
        Set s = s.ContainingShape
    Loop
End Function

Private Function RoleOfShape(s As Visio.Shape) As String
    If KeyExists(mAttrMap, "k" & s.ID) Then RoleOfShape = "Attraction": Exit Function
    If KeyExists(mRole, "k" & s.ID) Then RoleOfShape = mRole("k" & s.ID)
End Function

' Final node id for a (possibly sub-) shape, after pass C assigned ids.
Private Function FinalId(shp As Visio.Shape) As String
    Dim s As Visio.Shape: Set s = ClimbKnown(shp)
    If s Is Nothing Then Exit Function
    If KeyExists(mNodeMap, "k" & s.ID) Then FinalId = mNodeMap("k" & s.ID)(0)
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
    AttrIdFor = UniqueId("a" & shp.ID, used)
End Function

' Entrance/Exit id: Prop.ID, else <attractionId><suffix> (e.g. pirates_in).
Private Function NodeIdForRole(shp As Visio.Shape, role As String, attrId As String, _
                               suffix As String, used As Collection) As String
    Dim p As String: p = PropStr(shp, "ID")
    If p <> "" Then NodeIdForRole = UniqueId(p, used): Exit Function
    If attrId <> "" Then NodeIdForRole = UniqueId(attrId & suffix, used): Exit Function
    Warn role & " node (Shape ID " & shp.ID & ") is not linked to an Attraction - " & _
         "draw a line from its Attraction shape to it."
    NodeIdForRole = UniqueId(IIf(role = "Entrance", "ent", "ex") & shp.ID, used)
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
    ShapeText = Trim$(shp.Text)
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

Private Function RideDur(shp As Visio.Shape) As Double
    On Error Resume Next
    If shp.CellExistsU("Prop.RideDuration", 0) Then
        RideDur = shp.CellsU("Prop.RideDuration").ResultIU
        If RideDur > 0 Then Exit Function
    End If
    RideDur = DEFAULT_RIDE
End Function

Private Function ShapeName(shp As Visio.Shape) As String
    Dim p As String: p = PropStr(shp, "Name")
    If p <> "" Then ShapeName = p: Exit Function
    On Error Resume Next
    ShapeName = Trim$(shp.Text)
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

Private Function AttrJson(id As String, nm As String, entId As String, exId As String, _
                          x As Variant, y As Variant, ride As Double) As String
    AttrJson = "  { ""id"": """ & id & """, ""name"": """ & JStr(nm) & _
        """, ""entranceNodeId"": """ & entId & """, ""exitNodeId"": """ & exId & _
        """, ""displayLocation"": { ""x"": " & CLng(x) & ", ""y"": " & CLng(y) & _
        " }, ""rideDuration"": " & CLng(Round(ride)) & " }"
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
    folder = ThisDocument.Path
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
