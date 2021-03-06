/*!
 * Copyright 2014 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module datastore/request
 */

'use strict';

var arrify = require('arrify');
var concat = require('concat-stream');
var extend = require('extend');
var is = require('is');
var propAssign = require('prop-assign');
var split = require('split-array-stream');
var through = require('through2');

/**
 * @type {module:datastore/entity}
 * @private
 */
var entity = require('./entity.js');

/**
 * @type {module:datastore/query}
 * @private
 */
var Query = require('./query.js');

/**
 * @type {module:common/streamrouter}
 * @private
 */
var streamRouter = require('../common/stream-router.js');

/**
 * @type {module:common/util}
 * @private
 */
var util = require('../common/util.js');

/*! Developer Documentation
 *
 * Handles request logic for Datastore.
 *
 * Creates requests to the Datastore endpoint. Designed to be inherited by
 * {module:datastore} and {module:datastore/transaction} objects.
 *
 * @example
 * // This is how to create a transaction object directly using this Transaction
 * // class. The following transaction object is created for use in the examples
 * // in this file below.
 * var datastore = gcloud.datastore({ projectId: 'project-id' });
 * var Transaction = require('gcloud/lib/datastore/transaction');
 * var transaction = new Transaction(datastore, 'my-project-id');
 * transaction.id = '1234'; // Give the transaction an ID.
 */
/**
 * Handle logic for Datastore API operations.
 *
 * @constructor
 * @alias module:datastore/request
 * @mixin
 */
function DatastoreRequest() {}

/**
 * Generate IDs without creating entities.
 *
 * @param {Key} incompleteKey - The key object to complete.
 * @param {number} n - How many IDs to generate.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {array} callback.keys - The generated IDs
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * var incompleteKey = datastore.key(['Company']);
 *
 * //-
 * // The following call will create 100 new IDs from the Company kind, which
 * // exists under the default namespace.
 * //-
 * datastore.allocateIds(incompleteKey, 100, function(err, keys) {});
 *
 * //-
 * // Or, if you're using a transaction object.
 * //-
 * datastore.runInTransaction(function(transaction, done) {
 *   transaction.allocateIds(incompleteKey, 100, function(err, keys) {
 *     done();
 *   });
 * });
 *
 * //-
 * // You may prefer to create IDs from a non-default namespace by providing an
 * // incomplete key with a namespace. Similar to the previous example, the call
 * // below will create 100 new IDs, but from the Company kind that exists under
 * // the "ns-test" namespace.
 * //-
 * var incompleteKey = datastore.key({
 *   namespace: 'ns-test',
 *   path: ['Company']
 * });
 *
 * function callback(err, keys, apiResponse) {}
 *
 * datastore.allocateIds(incompleteKey, 100, callback);
 */
DatastoreRequest.prototype.allocateIds = function(incompleteKey, n, callback) {
  if (entity.isKeyComplete(incompleteKey)) {
    throw new Error('An incomplete key should be provided.');
  }

  var incompleteKeys = [];
  for (var i = 0; i < n; i++) {
    incompleteKeys.push(entity.keyToKeyProto(incompleteKey));
  }

  var protoOpts = {
    service: 'Datastore',
    method: 'allocateIds'
  };

  var reqOpts = {
    keys: incompleteKeys
  };

  this.request_(protoOpts, reqOpts, function(err, resp) {
    if (err) {
      callback(err, null, resp);
      return;
    }

    var keys = (resp.keys || []).map(entity.keyFromKeyProto);

    callback(null, keys, resp);
  });
};

/**
 * Delete all entities identified with the specified key(s).
 *
 * @param {Key|Key[]} key - Datastore key object(s).
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * var key = datastore.key(['Company', 123]);
 * datastore.delete(key, function(err, apiResp) {});
 *
 * //-
 * // Or, if you're using a transaction object.
 * //-
 * datastore.runInTransaction(function(transaction, done) {
 *   transaction.delete(key, function(err, apiResp) {
 *     done();
 *   });
 * });
 *
 * //-
 * // Delete multiple entities at once.
 * //-
 * datastore.delete([
 *   datastore.key(['Company', 123]),
 *   datastore.key(['Product', 'Computer'])
 * ], function(err, apiResponse) {});
 */
DatastoreRequest.prototype.delete = function(keys, callback) {
  callback = callback || util.noop;

  var protoOpts = {
    service: 'Datastore',
    method: 'commit'
  };

  var reqOpts = {
    mutations: arrify(keys).map(function(key) {
      return {
        delete: entity.keyToKeyProto(key)
      };
    })
  };

  if (this.id) {
    this.requests_.push(reqOpts);
    return;
  }

  this.request_(protoOpts, reqOpts, callback);
};

/**
 * Retrieve the entities identified with the specified key(s) in the current
 * transaction. Get operations require a valid key to retrieve the
 * key-identified entity from Datastore.
 *
 * @throws {Error} If at least one Key object is not provided.
 *
 * @param {Key|Key[]} keys - Datastore key object(s).
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object|object[]} callback.entity - The entity object(s) which match
 *     the provided keys.
 *
 * @example
 * //-
 * // Get a single entity.
 * //-
 * var key = datastore.key(['Company', 123]);
 *
 * datastore.get(key, function(err, entity) {});
 *
 * //-
 * // Or, if you're using a transaction object.
 * //-
 * datastore.runInTransaction(function(transaction, done) {
 *   transaction.get(key, function(err, entity) {
 *     done();
 *   });
 * });
 *
 * //-
 * // Get multiple entities at once with a callback.
 * //-
 * var keys = [
 *   datastore.key(['Company', 123]),
 *   datastore.key(['Product', 'Computer'])
 * ];
 *
 * datastore.get(keys, function(err, entities) {});
 *
 * //-
 * // Or, get the entities as a readable object stream.
 * //-
 * datastore.get(keys)
 *   .on('error', function(err) {})
 *   .on('data', function(entity) {
 *     // entity is an entity object.
 *   })
 *   .on('end', function() {
 *     // All entities retrieved.
 *   });
 *
 * //-
 * // Here's how you would update the value of an entity with the help of the
 * // `save` method.
 * //-
 * datastore.get(key, function(err, entity) {
 *   if (err) {
 *     // Error handling omitted.
 *   }
 *
 *   entity.data.newValue = true;
 *   datastore.save(entity, function(err) {});
 * });
 */
DatastoreRequest.prototype.get = function(keys, callback) {
  if (is.fn(callback)) {
    // Run this method in stream mode and send the results back to the callback.
    this.get(keys)
      .on('error', callback)
      .pipe(concat(function(results) {
        var isSingleLookup = !is.array(keys);
        callback(null, isSingleLookup ? results[0] : results);
      }));
    return;
  }

  keys = arrify(keys).map(entity.keyToKeyProto);

  if (keys.length === 0) {
    throw new Error('At least one Key object is required.');
  }

  var self = this;
  var stream = through.obj();

  function onApiResponse(err, resp) {
    if (err) {
      stream.destroy(err);
      return;
    }

    var entities = entity.formatArray(resp.found);
    var nextKeys = (resp.deferred || []).map(entity.keyFromKeyProto);

    split(entities, stream, function(streamEnded) {
      if (streamEnded) {
        return;
      }

      if (nextKeys.length > 0) {
        self.get(nextKeys, onApiResponse);
        return;
      }

      stream.push(null);
    });
  }

  var protoOpts = {
    service: 'Datastore',
    method: 'lookup'
  };

  var reqOpts = {
    keys: keys
  };

  this.request_(protoOpts, reqOpts, onApiResponse);

  return stream;
};

/**
 * Maps to {module:datastore#save}, forcing the method to be `insert`.
 */
DatastoreRequest.prototype.insert = function(entities, callback) {
  entities = arrify(entities).map(propAssign('method', 'insert'));
  this.save(entities, callback);
};

/**
 * Datastore allows you to query entities by kind, filter them by property
 * filters, and sort them by a property name. Projection and pagination are also
 * supported.
 *
 * If you provide a callback, the query is run, and the results are returned as
 * the second argument to your callback. A third argument may also exist, which
 * is a query object that uses the end cursor from the previous query as the
 * starting cursor for the next query. You can pass that object back to this
 * method to see if more results exist.
 *
 * You may also omit the callback to this function to trigger streaming mode.
 *
 * See below for examples of both approaches.
 *
 * @param {module:datastore/query} q - Query object.
 * @param {function=} callback - The callback function. If omitted, a readable
 *     stream instance is returned.
 * @param {?error} callback.err - An error returned while making this request
 *     (may be null).
 * @param {array} callback.entities - The list of entities returned by this
 *     query. Note that this is a single page of entities, not necessarily
 *     all of the entities.
 * @param {?module:datastore/query} callback.nextQuery - If present, run another
 *     query with this object to check for more results.
 * @param {object} callback.apiResponse - The full API response.
 * @param {?error} callback.err - An error returned while making this request
 * @param {module:datastore/entity[]} callback.entities - A list of Entities
 * @param {?object} callback.nextQuery - If present, query with this object to
 *     check for more results.
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // Where you see `transaction`, assume this is the context that's relevant to
 * // your use, whether that be a Datastore or a Transaction object.
 * //-
 * var query = datastore.createQuery('Lion');
 *
 * datastore.runQuery(query, function(err, entities) {});
 *
 * //-
 * // Or, if you're using a transaction object.
 * //-
 * datastore.runInTransaction(function(transaction, done) {
 *   transaction.runQuery(query, function(err, entities) {
 *     done();
 *   });
 * });
 *
 * //-
 * // To control how many API requests are made and page through the results
 * // manually, call `autoPaginate(false)` on your query.
 * //-
 * var manualPageQuery = datastore.createQuery('Lion').autoPaginate(false);
 *
 * function callback(err, entities, nextQuery, apiResponse) {
 *   if (nextQuery) {
 *     // More results might exist.
 *     transaction.runQuery(nextQuery, callback);
 *   }
 * }
 *
 * datastore.runQuery(manualPageQuery, callback);
 *
 * //-
 * // If you omit the callback, runQuery will automatically call subsequent
 * // queries until no results remain. Entity objects will be pushed as they are
 * // found.
 * //-
 * datastore.runQuery(query)
 *   .on('error', console.error)
 *   .on('data', function (entity) {})
 *   .on('end', function() {
 *     // All entities retrieved.
 *   });
 *
 * //-
 * // A keys-only query returns just the keys of the result entities instead of
 * // the entities themselves, at lower latency and cost.
 * //-
 * var keysOnlyQuery = datastore.createQuery('Lion').select('__key__');
 *
 * datastore.runQuery(keysOnlyQuery, function(err, entities) {
 *   // entities[].key = Key object
 *   // entities[].data = Empty object
 * });
 */
DatastoreRequest.prototype.runQuery = function(query, callback) {
  var self = this;

  var protoOpts = {
    service: 'Datastore',
    method: 'runQuery'
  };

  var reqOpts = {
    readOptions: {},
    query: entity.queryToQueryProto(query)
  };

  if (query.namespace) {
    reqOpts.partitionId = {
      namespaceId: query.namespace
    };
  }

  var originalLimitVal = query.limitVal;
  var entities = [];

  function onResponse(err, resp) {
    if (err) {
      callback(err, null, null, resp);
      return;
    }

    var nextQuery = null;

    if (resp.batch.entityResults) {
      entities = entities.concat(entity.formatArray(resp.batch.entityResults));
    }

    var notFinished = resp.batch.moreResults === 'NOT_FINISHED';
    var moreResults = resp.batch.moreResults === 'MORE_RESULTS_AFTER_LIMIT';

    if (notFinished || moreResults) {
      var endCursor = resp.batch.endCursor;
      var offset = query.offsetVal === -1 ? 0 : query.offsetVal;
      var nextOffset = offset - resp.batch.skippedResults;
      nextQuery = extend(true, new Query(), query);
      nextQuery.start(endCursor.toString('base64')).offset(nextOffset);
    }

    if (notFinished) {
      // Run the query again to make sure all of the requested entities are
      // returned.
      var limit = reqOpts.query.limit.value;
      if (limit > -1) {
        // Update the limit on the nextQuery to return only the amount of
        // results originally asked for.
        nextQuery.limit(limit - resp.batch.entityResults.length);
      }
      reqOpts.query = entity.queryToQueryProto(nextQuery);
      self.request_(protoOpts, reqOpts, onResponse);
      return;
    }

    if (nextQuery && originalLimitVal > -1) {
      // Restore the original limit value for the query.
      nextQuery.limit(originalLimitVal);
    }

    callback(null, entities, nextQuery, resp);
  }

  this.request_(protoOpts, reqOpts, onResponse);
};

/**
 * Insert or update the specified object(s). If a key is incomplete, its
 * associated object is inserted and the original Key object is updated to
 * contain the generated ID.
 *
 * This method will determine the correct Datastore method to execute (`upsert`,
 * `insert`, or `update`) by using the key(s) provided. For
 * example, if you provide an incomplete key (one without an ID), the request
 * will create a new entity and have its ID automatically assigned. If you
 * provide a complete key, the entity will be updated with the data specified.
 *
 * By default, all properties are indexed. To prevent a property from being
 * included in *all* indexes, you must supply an entity's `data` property as an
 * array. See below for an example.
 *
 * @borrows {module:datastore/transaction#save} as save
 *
 * @throws {Error} If an unrecognized method is provided.
 *
 * @param {object|object[]} entities - Datastore key object(s).
 * @param {Key} entities.key - Datastore key object.
 * @param {string=} entities.method - Explicit method to use, either 'insert',
 *     'update', or 'upsert'.
 * @param {object|object[]} entities.data - Data to save with the provided key.
 *     If you provide an array of objects, you must use the explicit syntax:
 *     `name` for the name of the property and `value` for its value. You may
 *     also specify an `excludeFromIndexes` property, set to `true` or `false`.
 * @param {function} callback - The callback function.
 * @param {?error} callback.err - An error returned while making this request
 * @param {object} callback.apiResponse - The full API response.
 *
 * @example
 * //-
 * // Save a single entity.
 * //
 * // Notice that we are providing an incomplete key. After saving, the original
 * // Key object used to save will be updated to contain the path with its
 * // generated ID.
 * //-
 * var key = datastore.key('Company');
 *
 * datastore.save({
 *   key: key,
 *   data: {
 *     rating: '10'
 *   }
 * }, function(err) {
 *   console.log(key.path); // [ 'Company', 5669468231434240 ]
 *   console.log(key.namespace); // undefined
 * });
 *
 * //-
 * // Save a single entity using a provided name instead of auto-generated ID.
 * //
 * // Here we are providing a key with name instead of an ID. After saving, the
 * // original Key object used to save will be updated to contain the path with
 * // the name instead of a generated ID.
 * //-
 * var key = datastore.key(['Company', 'donutshack']);
 *
 * datastore.save({
 *   key: key,
 *   data: {
 *     name: 'DonutShack',
 *     rating: 8
 *   }
 * }, function(err) {
 *   console.log(key.path); // ['Company', 'donutshack']
 *   console.log(key.namespace); // undefined
 * });
 *
 * //-
 * // Save a single entity with a provided namespace. Namespaces allow for
 * // multitenancy. To read more about this, see
 * // [the Datastore docs on key concepts](https://goo.gl/M1LUAu).
 * //
 * // Here we are providing a key with namespace.
 * //-
 * var key = datastore.key({
 *   namespace: 'my-namespace',
 *   path: ['Company', 'donutshack']
 * });
 *
 * datastore.save({
 *   key: key,
 *   data: {
 *     name: 'DonutShack',
 *     rating: 8
 *   }
 * }, function(err) {
 *   console.log(key.path); // ['Company', 'donutshack']
 *   console.log(key.namespace); // 'my-namespace'
 * });
 *
 * //-
 * // Save different types of data, including ints, doubles, dates, booleans,
 * // blobs, and lists.
 * //
 * // Notice that we are providing an incomplete key. After saving, the original
 * // Key object used to save will be updated to contain the path with its
 * // generated ID.
 * //-
 * var key = datastore.key('Company');
 *
 * datastore.save({
 *   key: key,
 *   data: {
 *     name: 'DonutShack',
 *     rating: gcloud.datastore.int(10),
 *     worth: gcloud.datastore.double(123456.78),
 *     location: gcloud.datastore.geoPoint({
 *       latitude: 40.6894,
 *       longitude: -74.0447
 *     }),
 *     numDonutsServed: 45,
 *     founded: new Date('Tue May 12 2015 15:30:00 GMT-0400 (EDT)'),
 *     isStartup: true,
 *     donutEmoji: new Buffer('\uD83C\uDF69'),
 *     keywords: [
 *       'donut',
 *       'coffee',
 *       'yum'
 *     ]
 *   }
 * }, function(err, apiResponse) {});
 *
 * //-
 * // To specify an `excludeFromIndexes` value for a Datastore entity, pass in
 * // an array for the key's data.
 * //-
 * datastore.save({
 *   key: datastore.key('Company'),
 *   data: [
 *     {
 *       name: 'rating',
 *       value: 10,
 *       excludeFromIndexes: true
 *     }
 *   ]
 * }, function(err, apiResponse) {});
 *
 * //-
 * // Save multiple entities at once.
 * //-
 * var companyKey = datastore.key(['Company', 123]);
 * var productKey = datastore.key(['Product', 'Computer']);
 *
 * datastore.save([
 *   {
 *     key: companyKey,
 *     data: {
 *       HQ: 'Dallas, TX'
 *     }
 *   },
 *   {
 *     key: productKey,
 *     data: {
 *       vendor: 'Dell'
 *     }
 *   }
 * ], function(err, apiResponse) {});
 *
 * //-
 * // Explicitly attempt to 'insert' a specific entity.
 * //-
 * var userKey = datastore.key(['User', 'chilts']);
 *
 * datastore.save({
 *   key: userKey,
 *   method: 'insert',
 *   data: {
 *     fullName: 'Andrew Chilton'
 *   }
 * }, function(err, apiResponse) {});
 */
DatastoreRequest.prototype.save = function(entities, callback) {
  entities = arrify(entities);

  var insertIndexes = {};
  var mutations = [];
  var methods = {
    insert: true,
    update: true,
    upsert: true
  };

  // Iterate over the entity objects, build a proto from all keys and values,
  // then place in the correct mutation array (insert, update, etc).
  entities.forEach(function(entityObject, index) {
    entityObject = extend(true, {}, entityObject);

    var mutation = {};
    var entityProto = {};
    var method = 'upsert';

    if (entityObject.method) {
      if (methods[entityObject.method]) {
        method = entityObject.method;
      } else {
        throw new Error('Method ' + entityObject.method + ' not recognized.');
      }
    }

    if (!entity.isKeyComplete(entityObject.key)) {
      insertIndexes[index] = true;
    }

    if (is.array(entityObject.data)) {
      entityProto.properties = entityObject.data.reduce(function(acc, data) {
        var value = entity.encodeValue(data.value);

        if (is.boolean(data.excludeFromIndexes)) {
          var excluded = data.excludeFromIndexes;
          var values = value.arrayValue && value.arrayValue.values;

          if (values) {
            values = values.map(propAssign('excludeFromIndexes', excluded));
          } else {
            value.excludeFromIndexes = data.excludeFromIndexes;
          }
        }

        acc[data.name] = value;

        return acc;
      }, {});
    } else {
      entityProto = entity.entityToEntityProto(entityObject.data);
    }

    entityProto.key = entity.keyToKeyProto(entityObject.key);

    mutation[method] = entityProto;
    mutations.push(mutation);
  });

  var protoOpts = {
    service: 'Datastore',
    method: 'commit'
  };

  var reqOpts = {
    mutations: mutations
  };

  function onCommit(err, resp) {
    if (err || !resp) {
      callback(err, resp);
      return;
    }

    arrify(resp.mutationResults).forEach(function(result, index) {
      if (!result.key) {
        return;
      }

      if (insertIndexes[index]) {
        var id = entity.keyFromKeyProto(result.key).id;
        entities[index].key.id = id;
      }
    });

    callback(null, resp);
  }

  if (this.id) {
    this.requests_.push(reqOpts);
    this.requestCallbacks_.push(onCommit);
    return;
  }

  this.request_(protoOpts, reqOpts, onCommit);
};

/**
 * Maps to {module:datastore#save}, forcing the method to be `update`.
 */
DatastoreRequest.prototype.update = function(entities, callback) {
  entities = arrify(entities).map(propAssign('method', 'update'));
  this.save(entities, callback);
};

/**
 * Maps to {module:datastore#save}, forcing the method to be `upsert`.
 */
DatastoreRequest.prototype.upsert = function(entities, callback) {
  entities = arrify(entities).map(propAssign('method', 'upsert'));
  this.save(entities, callback);
};

/**
 * Make a request to the API endpoint. Properties to indicate a transactional or
 * non-transactional operation are added automatically.
 *
 * @param {string} method - Datastore action (allocateIds, commit, etc.).
 * @param {object=} body - Request configuration object.
 * @param {function} callback - The callback function.
 *
 * @private
 */
DatastoreRequest.prototype.request_ = function(protoOpts, reqOpts, callback) {
  if (!callback) {
    callback = reqOpts;
    reqOpts = {};
  }

  callback = callback || util.noop;

  var isTransaction = is.defined(this.id);
  var method = protoOpts.method;

  reqOpts.projectId = this.projectId;

  // Set properties to indicate if we're in a transaction or not.
  if (method === 'commit') {
    if (isTransaction) {
      reqOpts.mode = 'TRANSACTIONAL';
      reqOpts.transaction = this.id;
    } else {
      reqOpts.mode = 'NON_TRANSACTIONAL';
    }
  }

  if (method === 'rollback') {
    reqOpts.transaction = this.id;
  }

  if (isTransaction && (method === 'lookup' || method === 'runQuery')) {
    reqOpts.readOptions = reqOpts.readOptions || {};
    reqOpts.readOptions.transaction = this.id;
  }

  this.request(protoOpts, reqOpts, callback);
};

/*! Developer Documentation
 *
 * This method can be used with either a callback or as a readable object
 * stream. `streamRouter` is used to add this dual behavior.
 */
streamRouter.extend(DatastoreRequest, 'runQuery');

module.exports = DatastoreRequest;
