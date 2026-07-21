function showTab(tab) {

    const isLogin = tab === 'login';


    document
    .getElementById('tabLogin')
    .classList
    .toggle('active', isLogin);


    document
    .getElementById('tabRegister')
    .classList
    .toggle('active', !isLogin);



    document
    .getElementById('loginForm')
    .classList
    .toggle('active', isLogin);



    document
    .getElementById('registerForm')
    .classList
    .toggle('active', !isLogin);


}






document
.getElementById('loginForm')
.addEventListener('submit', async (e)=>{


    e.preventDefault();



    const errEl =
    document.getElementById('loginError');


    errEl.textContent = '';



    try {


        const res =
        await fetch('/admin/login', {


            method:'POST',


            headers:{
                'Content-Type':'application/json'
            },


            body:JSON.stringify({

                username:
                document
                .getElementById('loginUsername')
                .value
                .trim(),


                password:
                document
                .getElementById('loginPassword')
                .value

            })


        });



        const data =
        await res.json();



        if(!res.ok){

            errEl.textContent =
            data.error || 'שגיאה בכניסה';

            return;

        }



        location.href =
        '/games.html';



    }


    catch {


        errEl.textContent =
        'שגיאת רשת - נסו שוב';


    }


});









document
.getElementById('registerForm')
.addEventListener('submit', async (e)=>{


    e.preventDefault();



    const errEl =
    document.getElementById('registerError');


    errEl.textContent='';



    try{


        const res =
        await fetch('/admin/register', {


            method:'POST',


            headers:{
                'Content-Type':'application/json'
            },


            body:JSON.stringify({

                username:
                document
                .getElementById('regUsername')
                .value
                .trim(),


                password:
                document
                .getElementById('regPassword')
                .value


            })


        });




        const data =
        await res.json();




        if(!res.ok){


            errEl.textContent =
            data.error || 'שגיאה בהרשמה';


            return;

        }



        location.href =
        '/games.html';


    }


    catch{


        errEl.textContent =
        'שגיאת רשת - נסו שוב';


    }


});







// בדיקה אם המשתמש כבר מחובר

fetch('/admin/me')

.then(r=>r.json())

.then(d=>{


    if(d.authenticated){

        location.href='/games.html';

    }


});
