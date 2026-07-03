const fs = require('fs');
const path = require('path');
const { LuaFactory } = require('wasmoon');

async function runTests() {
    console.log('Initializing Lua VM...');
    const factory = new LuaFactory();
    const lua = await factory.createEngine();

    // 1. Load mock environment in Lua
    const mocks = `
        -- Lua mocks for Fantasy Grounds APIs
        DBNode = {}
        DBNode.__index = DBNode

        function DBNode.new(name, parent)
            local self = {}
            self._name = name or ""
            self._parent = parent
            self._children = {}
            self._value = nil

            -- Closures for method binding to support dot syntax
            self.getParent = function()
                return self._parent
            end

            self.getPath = function()
                if self._parent then
                    return self._parent.getPath() .. "." .. self._name
                else
                    return self._name
                end
            end

            self.getChild = function(childName)
                if childName == "." then
                    return self
                elseif childName == ".." then
                    return self._parent
                elseif childName == "..." then
                    return self._parent and self._parent.getParent()
                end
                return self._children[childName]
            end

            self.createChild = function(childName)
                if not self._children[childName] then
                    self._children[childName] = DBNode.new(childName, self)
                end
                return self._children[childName]
            end

            self.delete = function()
                if self._parent then
                    self._parent._children[self._name] = nil
                end
            end

            return self
        end

        local function resolvePath(node, pathStr, create)
            if not node then return nil end
            if not pathStr or pathStr == "" then return node end
            
            local current = node
            for part in string.gmatch(pathStr, "[^%.]+") do
                if create then
                    current = current.createChild(part)
                else
                    current = current.getChild(part)
                    if not current then return nil end
                end
            end
            return current
        end

        DB = {}
        function DB.getChildren(node)
            if not node then return {} end
            return node._children
        end

        function DB.getValue(node, pathStr, default)
            local leaf = resolvePath(node, pathStr, false)
            if not leaf or leaf._value == nil then
                return default
            end
            return leaf._value
        end

        function DB.setValue(node, pathStr, typeStr, ...)
            local args = {...}
            local val = (#args == 1) and args[1] or args
            local leaf = resolvePath(node, pathStr, true)
            if leaf then
                leaf._value = val
            end
        end

        function DB.getPath(...)
            local parts = {}
            for i = 1, select("#", ...) do
                local v = select(i, ...)
                if v then table.insert(parts, tostring(v)) end
            end
            return table.concat(parts, ".")
        end

        function DB.addHandler(path, event, callback)
            if not DB.handlers then DB.handlers = {} end
            table.insert(DB.handlers, { path = path, event = event, callback = callback })
        end

        OptionsManager = {}
        OptionsManager.options = {}
        function OptionsManager.registerOption2(name, ...)
            -- no-op
        end
        function OptionsManager.isOption(name, value)
            return OptionsManager.options[name] == value
        end

        ActorManager = {}
        function ActorManager.resolveActor(nodeChar)
            local name = DB.getValue(nodeChar, "name", "Test Actor")
            return { sName = name }
        end

        Interface = {}
        Interface.strings = {
            item_overfull = "%s is overfull by %s",
            item_self_destruct = "%s has self-destructed or is overfull by %s"
        }
        function Interface.getString(key)
            return Interface.strings[key] or key
        end

        Comm = {}
        Comm.messages = {}
        function Comm.deliverChatMessage(msg)
            table.insert(Comm.messages, msg)
        end

        CharEncumbranceManager = {}
        CharEncumbranceManager.currencyEncumbrance = 0
        function CharEncumbranceManager.calcDefaultCurrencyEncumbrance(nodeChar)
            return CharEncumbranceManager.currencyEncumbrance
        end
        function CharEncumbranceManager.setDefaultEncumbranceValue(nodeChar, value)
            CharEncumbranceManager.lastDefaultValue = value
        end
        function CharEncumbranceManager.getEncumbranceField()
            return "encumbrance.load"
        end

        ItemManager = {}
        function ItemManager.getInventoryPaths(charsheet)
            return { "inventorylist" }
        end
        ItemManager.onInventorySortUpdate = function() end

        Session = {
            IsHost = true
        }

        -- Assertions Framework
        passed = 0
        failed = 0
        failures = {}

        function assertEqual(actual, expected, message)
            if actual == expected then
                passed = passed + 1
            else
                failed = failed + 1
                local msg = string.format("FAIL: %s (Expected %s, got %s)", message or "assertion failed", tostring(expected), tostring(actual))
                table.insert(failures, msg)
                print(msg)
            end
        end

        function assertNotNil(actual, message)
            if actual ~= nil then
                passed = passed + 1
            else
                failed = failed + 1
                local msg = string.format("FAIL: %s (Expected not nil)", message or "assertion failed")
                table.insert(failures, msg)
                print(msg)
            end
        end

        function assertNil(actual, message)
            if actual == nil then
                passed = passed + 1
            else
                failed = failed + 1
                local msg = string.format("FAIL: %s (Expected nil, got %s)", message or "assertion failed", tostring(actual))
                table.insert(failures, msg)
                print(msg)
            end
        end

        -- Test Helper Functions
        function setupTestEnv()
            Comm.messages = {}
            local charNode = DBNode.new("Char")
            local invNode = charNode.createChild("inventorylist")
            CharEncumbranceManager.currencyEncumbrance = 0
            CharEncumbranceManager.lastDefaultValue = nil
            return charNode, invNode
        end

        function createItem(invNode, id, name, weight, count, carried, location, volume, length, width, depth, capacityweight)
            local item = invNode.createChild(id)
            DB.setValue(item, "name", "string", name)
            DB.setValue(item, "weight", "number", weight or 0)
            DB.setValue(item, "count", "number", count or 1)
            DB.setValue(item, "carried", "number", carried or 1)
            DB.setValue(item, "location", "string", location or "")
            if volume then DB.setValue(item, "volume", "number", volume) end
            if length then DB.setValue(item, "length", "number", length) end
            if width then DB.setValue(item, "width", "number", width) end
            if depth then DB.setValue(item, "depth", "number", depth) end
            if capacityweight then DB.setValue(item, "capacityweight", "number", capacityweight) end
            return item
        end
    `;

    console.log('Loading mock environment...');
    await lua.doString(mocks);

    // 2. Read and run the target script
    const scriptPath = path.join(__dirname, '../scripts/extraplanarcontainers.lua');
    console.log(`Loading target Lua script: ${scriptPath}`);
    const scriptContent = fs.readFileSync(scriptPath, 'utf8');
    await lua.doString(scriptContent);

    // 3. Initialize the script
    console.log('Running onInit()...');
    await lua.doString('onInit()');

    // 4. Run tests
    const tests = `
        print("--- Running Test 1: isAnyContainer ---")
        assertEqual(isAnyContainer("backpack"), true, "backpack is a container")
        assertEqual(isAnyContainer("purse"), true, "purse is a container")
        assertEqual(isAnyContainer("Bag of Holding"), true, "Bag of Holding is a container (case insensitive)")
        assertEqual(isAnyContainer("portable hole"), true, "portable hole is a container")
        assertEqual(isAnyContainer("longsword"), nil, "longsword is not a container")
        assertEqual(isAnyContainer(""), nil, "empty string is not a container")
        assertEqual(isAnyContainer(nil), nil, "nil is not a container")

        print("--- Running Test 2: Mundane Container Weight Calculations ---")
        do
            local charNode, invNode = setupTestEnv()
            local backpack = createItem(invNode, "item1", "Backpack", 2, 1, 1, "", nil, nil, nil, nil, 50)
            local ration = createItem(invNode, "item2", "Ration", 1, 5, 1, "Backpack")
            local rope = createItem(invNode, "item3", "Silk Rope", 5, 1, 1, "Backpack")
            local sword = createItem(invNode, "item4", "Longsword", 4, 1, 1, "")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 10, "backpack contents weight should be 10")
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 16, "total encumbrance should be 16")
        end

        print("--- Running Test 3: Extraplanar Container Weight Calculations ---")
        do
            local charNode, invNode = setupTestEnv()
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            local statue = createItem(invNode, "item2", "Gold Statue", 50, 1, 1, "Bag of Holding")
            local sword = createItem(invNode, "item3", "Longsword", 4, 1, 1, "")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "extraplanarcontents", 0), 50, "BOH contents weight should be 50")
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 19, "total encumbrance should be 19")
        end

        print("--- Running Test 4: Nested Container (Backpack in Bag of Holding) ---")
        do
            local charNode, invNode = setupTestEnv()
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            local backpack = createItem(invNode, "item2", "Backpack", 2, 1, 1, "Bag of Holding", nil, nil, nil, nil, 50)
            local ration = createItem(invNode, "item3", "Ration", 1, 5, 1, "Backpack")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 5, "backpack contents weight should be 5")
            assertEqual(DB.getValue(boh, "extraplanarcontents", 0), 7, "BOH contents weight should be 7")
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 15, "total encumbrance should be 15")
        end

        print("--- Running Test 5: Nested Container (Bag of Holding in Backpack) ---")
        do
            local charNode, invNode = setupTestEnv()
            local backpack = createItem(invNode, "item1", "Backpack", 2, 1, 1, "", nil, nil, nil, nil, 50)
            local boh = createItem(invNode, "item2", "Bag of Holding", 15, 1, 1, "Backpack", nil, nil, nil, nil, 500)
            local statue = createItem(invNode, "item3", "Gold Statue", 50, 1, 1, "Bag of Holding")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "extraplanarcontents", 0), 50, "BOH contents weight should be 50")
            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 15, "backpack contents weight should be 15")
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 17, "total encumbrance should be 17")
        end

        print("--- Running Test 6: Volume Calculations (Option Off) ---")
        do
            local charNode, invNode = setupTestEnv()
            OptionsManager.options["ITEM_VOLUME"] = "off"
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            DB.setValue(boh, "internal_volume", "number", 100)
            local bigItem = createItem(invNode, "item2", "Big Statue", 10, 1, 1, "Bag of Holding", 150)

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "contentsvolume", 0), 0, "volume should be 0 when option is off")
            assertEqual(#Comm.messages, 0, "should be no chat messages when option is off")
        end

        print("--- Running Test 7: Volume Calculations (Option On) ---")
        do
            local charNode, invNode = setupTestEnv()
            OptionsManager.options["ITEM_VOLUME"] = "on"
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            DB.setValue(boh, "internal_volume", "number", 100)
            local item = createItem(invNode, "item2", "Statue", 10, 1, 1, "Bag of Holding", 60)

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "contentsvolume", 0), 60, "contents volume should be 60")
            assertEqual(#Comm.messages, 0, "no overfull message should be sent")
        end

        print("--- Running Test 8: Volume Exceeded Alert ---")
        do
            local charNode, invNode = setupTestEnv()
            OptionsManager.options["ITEM_VOLUME"] = "on"
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            DB.setValue(boh, "internal_volume", "number", 100)
            local item = createItem(invNode, "item2", "Heavy Statue", 10, 1, 1, "Bag of Holding", 120)

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "contentsvolume", 0), 120, "contents volume should be 120")
            assertNotNil(boh.getChild("announcedV"), "announcedV node should exist")
            assertEqual(#Comm.messages, 1, "one chat message should be delivered")
            local expectedMsg = string.format("Bag of Holding has self-destructed or is overfull by volume")
            assertEqual(Comm.messages[1].text, expectedMsg, "chat message text should indicate volume exceed")
        end

        print("--- Running Test 9: Dimension Exceeded (Too Big) ---")
        do
            local charNode, invNode = setupTestEnv()
            OptionsManager.options["ITEM_VOLUME"] = "on"
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            DB.setValue(boh, "internal_volume", "number", 100)
            DB.setValue(boh, "internal_length", "number", 5)
            DB.setValue(boh, "internal_width", "number", 5)
            DB.setValue(boh, "internal_depth", "number", 5)
            local spear = createItem(invNode, "item2", "Spear", 3, 1, 1, "Bag of Holding", 10, 6, 2, 2)

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertNotNil(boh.getChild("announcedV"), "announcedV node should exist")
            assertEqual(#Comm.messages, 1, "one chat message should be delivered")
            local expectedMsg = string.format("Bag of Holding has self-destructed or is overfull by maximum dimension")
            assertEqual(Comm.messages[1].text, expectedMsg, "chat message text should indicate maximum dimension exceed")
        end

        print("--- Running Test 10: Chat Message Throttling (Weight) ---")
        do
            local charNode, invNode = setupTestEnv()
            local backpack = createItem(invNode, "item1", "Backpack", 2, 1, 1, "", nil, nil, nil, nil, 10)
            local anvil = createItem(invNode, "item2", "Anvil", 15, 1, 1, "Backpack")

            CharEncumbranceManager.updateEncumbrance(charNode)
            assertEqual(#Comm.messages, 1, "should send 1 message on first exceed")
            assertNotNil(backpack.getChild("announcedW"), "announcedW flag should be created")

            CharEncumbranceManager.updateEncumbrance(charNode)
            assertEqual(#Comm.messages, 1, "should NOT send another message (throttled)")

            -- Now set weight to under limit (5)
            DB.setValue(anvil, "weight", "number", 5)
            CharEncumbranceManager.updateEncumbrance(charNode)
            assertEqual(#Comm.messages, 1, "no new message when weight under limit")
            assertEqual(backpack.getChild("announcedW"), nil, "announcedW flag should be deleted")

            -- Make it heavy again (12)
            DB.setValue(anvil, "weight", "number", 12)
            CharEncumbranceManager.updateEncumbrance(charNode)
            assertEqual(#Comm.messages, 2, "should send a second message when over limit again")
            assertNotNil(backpack.getChild("announcedW"), "announcedW flag should be recreated")
        end

        print("--- Running Test 11: Equipped Item Behavior ---")
        do
            local charNode, invNode = setupTestEnv()
            local boh = createItem(invNode, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            local sword = createItem(invNode, "item2", "Sun Blade", 3, 1, 2, "Bag of Holding")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "extraplanarcontents", 0), 0, "BOH contents weight should be 0")
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 18, "total encumbrance should include equipped item")
        end

        print("--- Running Test 12: Currency and Default Encumbrance Calculations ---")
        do
            local charNode, invNode = setupTestEnv()
            CharEncumbranceManager.currencyEncumbrance = 12.5
            createItem(invNode, "item1", "Longsword", 4, 1, 1, "")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(CharEncumbranceManager.lastDefaultValue, 16.5, "default encumbrance value should be 16.5")
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 17, "rounded encumbrance load should be 17")
        end

        print("--- Running Test 13: Multiple Inventory Paths ---")
        do
            local charNode, invNode1 = setupTestEnv()
            function ItemManager.getInventoryPaths(charsheet)
                return { "inventorylist", "otherinventory" }
            end
            local invNode2 = charNode.createChild("otherinventory")

            local boh = createItem(invNode1, "item1", "Bag of Holding", 15, 1, 1, "", nil, nil, nil, nil, 500)
            local statue = createItem(invNode1, "item2", "Gold Statue", 50, 1, 1, "Bag of Holding")

            local backpack = createItem(invNode2, "item3", "Backpack", 2, 1, 1, "", nil, nil, nil, nil, 50)
            local ration = createItem(invNode2, "item4", "Ration", 1, 5, 1, "Backpack")

            CharEncumbranceManager.updateEncumbrance(charNode)

            assertEqual(DB.getValue(boh, "extraplanarcontents", 0), 50, "BOH contents weight should be 50")
            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 5, "backpack contents weight should be 5")
            -- Since the last list calculated is otherinventory, it overwrites the encumbrance field value to 7.
            assertEqual(DB.getValue(charNode, "encumbrance.load", 0), 7, "total encumbrance across multiple lists should be 7")

            function ItemManager.getInventoryPaths(charsheet)
                return { "inventorylist" }
            end
        end

        print("--- Running Test 14: DB Update Triggers ---")
        do
            local charNode, invNode = setupTestEnv()
            local backpack = createItem(invNode, "item1", "Backpack", 2, 1, 1, "", nil, nil, nil, nil, 50)
            local ration = createItem(invNode, "item2", "Ration", 1, 5, 1, "Backpack")

            CharEncumbranceManager.updateEncumbrance(charNode)
            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 5, "initial content weight should be 5")

            local onUpdateCallback = nil
            for _, handler in ipairs(DB.handlers) do
                if handler.event == "onUpdate" then
                    onUpdateCallback = handler.callback
                    break
                end
            end
            assertNotNil(onUpdateCallback, "onUpdate callback should be registered")

            local capNode = ration.createChild("capacityweight")
            DB.setValue(ration, "weight", "number", 2)
            onUpdateCallback(capNode)

            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 10, "onItemUpdate should trigger container update")

            local onItemDeletedCallback = nil
            for _, handler in ipairs(DB.handlers) do
                if handler.event == "onChildDeleted" then
                    onItemDeletedCallback = handler.callback
                    break
                end
            end
            assertNotNil(onItemDeletedCallback, "onChildDeleted callback should be registered")

            ration.delete()
            onItemDeletedCallback(ration)

            assertEqual(DB.getValue(backpack, "extraplanarcontents", 0), 0, "onItemDeleted should update container contents to 0")
        end

        print("--- Running Test 15: Sort Update Hook ---")
        do
            local oldCalled = false
            ItemManager.onInventorySortUpdate = function(cList, a, b)
                oldCalled = true
                assertEqual(a, "argA", "old sort should receive argA")
                assertEqual(b, "argB", "old sort should receive argB")
            end

            onInit()

            local filterApplied = false
            local mockCList = {
                applyFilter = function()
                    filterApplied = true
                end
            }

            ItemManager.onInventorySortUpdate(mockCList, "argA", "argB")

            assertEqual(oldCalled, true, "old sort function should be called")
            assertEqual(filterApplied, true, "cList.applyFilter should be called")
        end
    `;

    console.log('Running tests in Lua...');
    await lua.doString(tests);

    const passed = lua.global.get('passed');
    const failed = lua.global.get('failed');
    
    console.log('\n-----------------------------------');
    console.log(`Tests run completed: ${passed} passed, ${failed} failed.`);
    console.log('-----------------------------------');

    if (failed > 0) {
        console.error('Some tests failed!');
        const failuresList = lua.global.get('failures');
        for (const key in failuresList) {
            console.error(`- ${failuresList[key]}`);
        }
        process.exit(1);
    } else {
        console.log('All tests passed successfully!');
        process.exit(0);
    }
}

runTests().catch(err => {
    console.error('Error running tests:', err);
    process.exit(1);
});
