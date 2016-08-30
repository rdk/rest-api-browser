'use strict';

angular.module('RAB', ['ngRoute', 'ngSanitize', 'ui.codemirror','ui.unique'])
    .config(['$routeProvider',
        function ($routeProvider) {
            var resourcePrefix = AJS.contextPath() + '/download/resources/com.atlassian.labs.rest-api-browser:assets/rab';
            $routeProvider
                .when('/', {
                    templateUrl: resourcePrefix + '/views/main.html',
                    controller: 'MainCtrl'
                })
                .when('/search/:query', {
                    templateUrl: resourcePrefix + '/views/main.html',
                    controller: 'MainCtrl'
                })
                .when('/resource/:key', {
                    templateUrl: resourcePrefix + '/views/resource.html',
                    controller: 'ResourceCtrl'
                })
                .when('/resource/:key/:method', {
                    templateUrl: resourcePrefix + '/views/resource.html',
                    controller: 'ResourceCtrl'
                })
                .otherwise({
                    redirectTo: '/'
                });
        }
    ])
    .filter('encodeQuery', function(){
        // used as a workaround to the lack of catch-all routeParam support in angular
        // slashes in search query params are encoded with "::". This filter is applied
        // the filtered results url. The search query param is decoded in the mainCtrl.
        return function(input){
            if (!input) return;
            return input.replace(/\//g,'::');
        }
    })
    .filter('showPublicOnly', function($filter){
        return function(resources, publicOnly){
            if (publicOnly){
                return $filter('filter')(resources, {'public': true});
            } else {
                return resources;
            }
        };
    })
    .run(function($rootScope){
        // Draggable divider
        function initDivider(){
            function sizeSearchInput(offset) {
                offset = offset || 0;
                jQuery('.rab-search').css({
                    width: offset - 10,
                    maxWidth: offset - 10
                });
            }
            function sizeMainSection(offset) {
                var $main = jQuery('.rab-main');
                $main.width($main.parent().width() - offset);
            }
            function sizeSidebar(offset) {
                jQuery('.rab-sidebar').width(offset);
            }
            function sizeSections(offset) {
                sizeSearchInput(offset);
                sizeMainSection(offset);
                sizeSidebar(offset);
            }
            sizeSections(jQuery('.rab-divider').offset().left - 1);
            jQuery('.rab-divider')
                .draggable({
                    helper: function() {return jQuery('<div/>')},
                    axis: 'x',
                    cursor: 'col-resize',
                    drag: function(evt, ui){
                        sizeSections(ui.offset.left - 1);
                    }
                });
        }
        initDivider();
        jQuery(window).on('resize', initDivider);
    });