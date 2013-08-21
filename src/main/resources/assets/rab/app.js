'use strict';

angular.module('RAB', ['ui.codemirror'])
    .config(['$routeProvider',
        function ($routeProvider) {
        $routeProvider
            .when('/', {
                templateUrl: RAB.resourcePrefix + '/views/main.html',
                controller: 'MainCtrl'
            })
            .when('/search/:query', {
                templateUrl: RAB.resourcePrefix + '/views/main.html',
                controller: 'MainCtrl'
            })
            .when('/resource/:key', {
                templateUrl: RAB.resourcePrefix + '/views/resource.html',
                controller: 'ResourceCtrl'
            })
            .when('/resource/:key/:method', {
                templateUrl: RAB.resourcePrefix + '/views/resource.html',
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
    .run(function($rootScope){

            // Draggable divider
            function initDivider(){
                var sbWidth = jQuery('.rab-sidebar').width();
                var mainWidth = jQuery('.rab-main').width() + 40;
                var mainMarginLeft = parseInt(jQuery('.rab-main').css('margin-left'));
                jQuery('.rab-divider')
                    .css('margin-left',sbWidth + 'px')
                    .draggable({
                        axis: 'x',
                        cursor: 'col-resize',
                        drag: function(evt, ui){
                            jQuery('.rab-sidebar').width(sbWidth + ui.offset.left);
                            jQuery('.rab-main').width(mainWidth - ui.offset.left)
                                .css('margin-left',function(){
                                    return (mainMarginLeft + ui.offset.left) + "px";
                                })
                        }
                    });
            }
            initDivider();
            jQuery(window).on('resize', _.debounce(initDivider, 50));
    });