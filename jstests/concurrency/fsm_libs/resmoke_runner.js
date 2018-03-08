(function() {
    'use strict';

    load('jstests/concurrency/fsm_libs/runner.js');  // for runner.internals
    load('jstests/libs/discover_topology.js');       // For Topology and DiscoverTopology.

    const validateExecutionOptions = runner.internals.validateExecutionOptions;
    const prepareCollections = runner.internals.prepareCollections;
    const WorkloadFailure = runner.internals.WorkloadFailure;
    const throwError = runner.internals.throwError;
    const shouldSkipWorkload = runner.internals.shouldSkipWorkload;
    const setupWorkload = runner.internals.setupWorkload;
    const teardownWorkload = runner.internals.teardownWorkload;
    const setIterations = runner.internals.setIterations;
    const setThreadCount = runner.internals.setThreadCount;
    const loadWorkloadContext = runner.internals.loadWorkloadContext;

    // Returns true if the workload's teardown succeeds and false if the workload's teardown fails.
    function cleanupWorkload(workload, context, cluster, errors, header) {
        const phase = 'before workload ' + workload + ' teardown';

        try {
            teardownWorkload(workload, context, cluster);
        } catch (e) {
            errors.push(new WorkloadFailure(e.toString(), e.stack, 'main', header + ' Teardown'));
            return false;
        }

        return true;
    }

    function runWorkloads(workloads,
                          {cluster: clusterOptions = {}, execution: executionOptions = {}} = {}) {
        assert.gt(workloads.length, 0, 'need at least one workload to run');

        const executionMode = {serial: true};
        validateExecutionOptions(executionMode, executionOptions);
        Object.freeze(executionOptions);  // immutable after validation (and normalization)

        // Determine how strong to make assertions while simultaneously executing different
        // workloads.
        let assertLevel = AssertLevel.OWN_DB;
        if (clusterOptions.sameDB) {
            // The database is shared by multiple workloads, so only make the asserts that apply
            // when the collection is owned by an individual workload.
            assertLevel = AssertLevel.OWN_COLL;
        }
        if (clusterOptions.sameCollection) {
            // The collection is shared by multiple workloads, so only make the asserts that always
            // apply.
            assertLevel = AssertLevel.ALWAYS;
        }
        globalAssertLevel = assertLevel;

        const context = {};
        const applyMultipliers = true;
        loadWorkloadContext(workloads, context, executionOptions, applyMultipliers);

        // Constructing a Cluster instance calls its internal validateClusterOptions() function,
        // which fills in any properties that aren't explicitly present in 'clusterOptions'. We do
        // this before constructing a ThreadManager instance to make its dependency on the
        // 'clusterOptions' being filled in explicit.
        const cluster = new Cluster(clusterOptions);
        const threadMgr = new ThreadManager(clusterOptions, executionMode);

        Random.setRandomSeed(clusterOptions.seed);

        const errors = [];
        const cleanup = [];
        let teardownFailed = false;
        let startTime = Date.now();  // Initialize in case setupWorkload fails below.
        let totalTime;

        cluster.setup();

        // Filter out workloads that need to be skipped.
        //
        // TODO SERVER-30001: Replace usages of $config.skip() functions with excluding files in the
        // resmoke.py YAML suite by name or by tag.
        workloads = workloads.filter(workload => !shouldSkipWorkload(workload, context, cluster));
        jsTest.log('Workload(s) started: ' + workloads.join(' '));

        prepareCollections(workloads, context, cluster, clusterOptions, executionOptions);

        try {
            // Set up the thread manager for this set of workloads.
            startTime = Date.now();

            {
                const maxAllowedThreads = 100 * executionOptions.threadMultiplier;
                threadMgr.init(workloads, context, maxAllowedThreads);
            }

            // Call each workload's setup function.
            workloads.forEach(function(workload) {
                // Define "iterations" and "threadCount" properties on the workload's $config.data
                // object so that they can be used within its setup(), teardown(), and state
                // functions. This must happen after calling threadMgr.init() in case the thread
                // counts needed to be scaled down.
                setIterations(context[workload].config);
                setThreadCount(context[workload].config);

                setupWorkload(workload, context, cluster);
                cleanup.push(workload);
            });

            // Since the worker threads may be running with causal consistency enabled, we set the
            // initial clusterTime and initial operationTime for the sessions they'll create so that
            // they are guaranteed to observe the effects of the workload's $config.setup() function
            // being called.
            if (typeof executionOptions.sessionOptions === 'object' &&
                executionOptions.sessionOptions !== null) {
                // We only start a session for the worker threads and never start one for the main
                // thread. We can therefore get the clusterTime and operationTime tracked by the
                // underlying DummyDriverSession through any DB instance (i.e. the "test" database
                // here was chosen arbitrarily).
                const session = cluster.getDB('test').getSession();

                // JavaScript objects backed by C++ objects (e.g. BSON values from a command
                // response) do not serialize correctly when passed through the ScopedThread
                // constructor. To work around this behavior, we instead pass a stringified form of
                // the JavaScript object through the ScopedThread constructor and use eval() to
                // rehydrate it.
                executionOptions.sessionOptions.initialClusterTime =
                    tojson(session.getClusterTime());
                executionOptions.sessionOptions.initialOperationTime =
                    tojson(session.getOperationTime());
            }

            try {
                // Start this set of worker threads.
                threadMgr.spawnAll(cluster, executionOptions);
                // Allow 20% of the threads to fail. This allows the workloads to run on
                // underpowered test hosts.
                threadMgr.checkFailed(0.2);
            } finally {
                // Threads must be joined before destruction, so do this even in the presence of
                // exceptions.
                errors.push(...threadMgr.joinAll().map(
                    e => new WorkloadFailure(
                        e.err, e.stack, e.tid, 'Foreground ' + e.workloads.join(' '))));
            }
        } finally {
            // Call each workload's teardown function. After all teardowns have completed check if
            // any of them failed.
            const cleanupResults = cleanup.map(
                workload => cleanupWorkload(workload, context, cluster, errors, 'Foreground'));
            teardownFailed = cleanupResults.some(success => (success === false));

            totalTime = Date.now() - startTime;
            jsTest.log('Workload(s) completed in ' + totalTime + ' ms: ' + workloads.join(' '));
        }

        // Throw any existing errors so that resmoke.py can abort its execution of the test suite.
        throwError(errors);

        cluster.teardown();
    }

    if (typeof db === 'undefined') {
        throw new Error(
            'resmoke_runner.js must be run with the mongo shell already connected to the database');
    }

    const clusterOptions = {
        replication: {enabled: false},
        sharded: {enabled: false},
        useExistingConnectionAsSeed: true,
    };

    const topology = DiscoverTopology.findConnectedNodes(db.getMongo());

    if (topology.type === Topology.kReplicaSet) {
        clusterOptions.replication.enabled = true;
        clusterOptions.replication.numNodes = topology.nodes.length;
    } else if (topology.type === Topology.kShardedCluster) {
        throw new Error("resmoke_runner.js doesn't currently support sharded clusters");
    } else if (topology.type !== Topology.kStandalone) {
        throw new Error('Unrecognized topology format: ' + tojson(topology));
    }

    let workloads = TestData.fsmWorkloads;
    if (!Array.isArray(workloads)) {
        workloads = [workloads];
    }

    runWorkloads(workloads, {cluster: clusterOptions});
})();
