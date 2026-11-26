'use strict';

angular.module('RAB')
    .controller('MainCtrl', ['$rootScope', '$scope', '$routeParams',
        function ($rootScope,$scope,$routeParams) {
            // Used to load search filter if accessed from #/search/:query
            // AngularJS $routeParams already decodes the route parameter once.
            var query = $routeParams.query || '';
            $rootScope.searchQuery = query.replace(/::/g,'/');

        }]
    );
