// Copyright (c) 2025+, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
// Licensed under Creative Commons Public Domain (CC0) 

document.addEventListener('DOMContentLoaded', function() {
  const showButton = document.querySelector('#showJSON');
  showButton.addEventListener('click', function(e) {
    const preDiv = document.querySelector('#previewDiv');
    preDiv.style.display = 'block';    
  })
})

document.addEventListener('DOMContentLoaded', function() {
  const showButton = document.querySelector('#hideJSON');
  showButton.addEventListener('click', function(e) {
    const preDiv = document.querySelector('#previewDiv');
    preDiv.style.display = 'none';    
  })
})

document.addEventListener('DOMContentLoaded', function() {
  const showButton = document.querySelector('#showHTML');
  showButton.addEventListener('click', function(e) {
    const htmlviewDiv = document.querySelector('#htmlviewDiv');
    htmlviewDiv.style.display = 'block';  
  })
})

document.addEventListener('DOMContentLoaded', function() {
  const showButton = document.querySelector('#hideHTML');
  showButton.addEventListener('click', function(e) {
    const htmlviewDiv = document.querySelector('#htmlviewDiv');
    htmlviewDiv.style.display = 'none';    
  })
})

document.addEventListener('DOMContentLoaded', function() {
  const zipButton = document.querySelector('#showIPS');
  if (zipButton) {
    zipButton.removeAttribute('onClick');
    zipButton.addEventListener('click', showIPS);
  }
});

async function handleFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
      try {
          const jsonData = JSON.parse(e.target.result);
          const form = document.getElementById('form');
            
          const formWrapper = {
              set: function(name, value) {
                  // Find the form element with this name
                  const element = form.querySelector(`[name="${name}"]`);
                  if (element) {
                      if (element.type === 'checkbox') {
                          element.checked = (value === 'true');
                      } else {
                          element.value = value;
                      }
                  }
              }
          };
          parseIPS(jsonData, formWrapper);
      } catch (err) {
          console.error('Error parsing JSON:', err);
      }
  };
  reader.readAsText(file);
}
