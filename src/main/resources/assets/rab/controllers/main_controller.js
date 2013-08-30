'use strict';

angular.module('RAB')
    .controller('MainCtrl', ['$rootScope', '$scope', '$routeParams',
        function ($rootScope,$scope,$routeParams) {
            // Used to load search filter if accessed from #/search/:query
            // Search query is decoded before being set.
            $rootScope.searchQuery = $routeParams.query ? $routeParams.query.replace(/::/g,'/') : '';
            $rootScope.publicOnly = true;

        }]
    );
